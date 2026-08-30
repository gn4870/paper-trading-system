/**
 * Express 应用组装层。
 *
 * REST 负责命令和完整快照，WebSocket 由同一 HTTP Server 的 upgrade 事件处理。
 * 生产环境还由这里托管 Vue 构建产物，并严格保留 /api 与 /ws 命名空间。
 */
import {
  loginSchema,
  placeOrderSchema,
  registerSchema,
  type BootstrapResponse
} from "@paper/shared";
import { stringifySetCookie } from "cookie";
import express, { type RequestHandler, type Response } from "express";
import { extname, relative, resolve } from "node:path";

import { AccountLedger } from "../accounts/account-ledger.js";
import { AuthService } from "../auth/auth-service.js";
import {
  EventJournal,
  type IdGenerator
} from "../infrastructure/event-journal.js";
import { MemoryState } from "../infrastructure/memory-state.js";
import { MarketSimulator } from "../market/market-simulator.js";
import { OrderService } from "../orders/order-service.js";
import {
  authenticateSession,
  requireAuth,
  SESSION_COOKIE
} from "./auth-middleware.js";
import {
  createErrorHandler,
  HttpError,
  type ServerErrorLogEntry
} from "./error-handler.js";

export interface RequestLogEntry {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

export type AppLogEntry = RequestLogEntry | ServerErrorLogEntry;

export interface AppDependencies {
  state: MemoryState;
  ledger: AccountLedger;
  auth: AuthService;
  orders: OrderService;
  market: MarketSimulator;
  journal: EventJournal;
  requestIds?: IdGenerator;
  nowMs?: () => number;
  log?: (entry: AppLogEntry) => void;
  staticDirectory?: string;
  marketLoopActive?: () => boolean;
}

const defaultRequestIds: IdGenerator = { next: () => crypto.randomUUID() };
const contentHashedAsset = (
  filePath: string,
  staticDirectory: string
): boolean =>
  /^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:css|js|mjs)$/.test(
    relative(staticDirectory, filePath).replaceAll("\\", "/")
  );
const hasDotSegment = (path: string): boolean =>
  path.split("/").some((segment) => segment.startsWith("."));
const decodePathname = (pathname: string): string | undefined => {
  try {
    return decodeURIComponent(pathname).replaceAll("\\", "/");
  } catch {
    return undefined;
  }
};
const isReservedNamespace = (pathname: string): boolean =>
  pathname === "/api" ||
  pathname.startsWith("/api/") ||
  pathname === "/ws" ||
  pathname.startsWith("/ws/");
const setSessionCookie = (response: Response, sessionId: string): void => {
  response.append(
    "Set-Cookie",
    stringifySetCookie({
      name: SESSION_COOKIE,
      value: sessionId,
      httpOnly: true,
      sameSite: "lax",
      path: "/"
    })
  );
};

const clearSessionCookie = (response: Response): void => {
  response.append(
    "Set-Cookie",
    stringifySetCookie({
      name: SESSION_COOKIE,
      value: "",
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
      expires: new Date(0)
    })
  );
};

export const createApp = (dependencies: AppDependencies) => {
  const app = express();
  const requestIds = dependencies.requestIds ?? defaultRequestIds;
  const nowMs = dependencies.nowMs ?? Date.now;
  const log =
    dependencies.log ??
    ((entry: AppLogEntry) => {
      if ("error" in entry) console.error(entry);
      else console.info(entry);
    });

  const requestMetadata: RequestHandler = (req, res, next) => {
    const startedAt = nowMs();
    req.requestId = requestIds.next();
    res.setHeader("X-Request-Id", req.requestId);
    // 日志只包含有界请求元数据，不记录 Cookie、密码或请求正文。
    res.once("finish", () => {
      try {
        log({
          requestId: req.requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.max(0, nowMs() - startedAt)
        });
      } catch {
        // Request logging cannot change an already completed response.
      }
    });
    next();
  };

  app.use(requestMetadata);
  app.use(express.json({ limit: "32kb" }));
  app.use(authenticateSession(dependencies.auth));

  app.post("/api/auth/register", async (req, res) => {
    const input = registerSchema.parse(req.body);
    const result = await dependencies.auth.register(
      input.username,
      input.password
    );
    setSessionCookie(res, result.sessionId);
    res.status(201).json({ user: result.user });
  });

  app.post("/api/auth/login", async (req, res) => {
    const input = loginSchema.parse(req.body);
    const result = await dependencies.auth.login(
      input.username,
      input.password
    );
    setSessionCookie(res, result.sessionId);
    res.status(200).json({ user: result.user });
  });

  app.post("/api/auth/logout", (req, res) => {
    if (req.authSessionId !== undefined) {
      dependencies.auth.logout(req.authSessionId);
    }
    clearSessionCookie(res);
    res.status(204).end();
  });

  app.get("/api/bootstrap", requireAuth, (req, res) => {
    const user = req.authUser!;
    // 快照与 stateVersion 共同构成前端重连恢复的基线。
    const snapshot: BootstrapResponse = {
      user,
      account: dependencies.ledger.snapshot(user.id),
      stocks: dependencies.market.snapshots(),
      orders: dependencies.orders.listForUser(user.id),
      trades: dependencies.orders.recentTradesForUser(user.id),
      stateVersion: dependencies.journal.currentVersion
    };
    res.status(200).json(snapshot);
  });

  app.post("/api/orders", requireAuth, (req, res) => {
    const input = placeOrderSchema.parse(req.body);
    const result = dependencies.orders.place(req.authUser!.id, input);
    res.status(result.replayed ? 200 : 201).json(result);
  });

  app.delete<{ orderId: string }>(
    "/api/orders/:orderId",
    requireAuth,
    (req, res) => {
      const result = dependencies.orders.cancel(
        req.authUser!.id,
        req.params.orderId
      );
      res.status(200).json(result);
    }
  );

  app.get("/api/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      marketLoop: { active: dependencies.marketLoopActive?.() ?? false }
    });
  });

  app.use("/api", (_req, _res, next) => {
    next(new HttpError("NOT_FOUND", 404, "接口不存在"));
  });

  app.use("/ws", (_req, _res, next) => {
    next(new HttpError("NOT_FOUND", 404, "接口不存在"));
  });

  if (dependencies.staticDirectory !== undefined) {
    const staticDirectory = resolve(dependencies.staticDirectory);
    // 解码后再判断保留路径，防止编码后的 /api、/ws 或反斜杠绕过检查。
    app.use((req, _res, next) => {
      const decodedPath = decodePathname(req.path);
      if (decodedPath === undefined) {
        next(new HttpError("INVALID_PATH", 400, "请求路径无法解析"));
        return;
      }
      if (isReservedNamespace(decodedPath)) {
        next(new HttpError("NOT_FOUND", 404, "接口不存在"));
        return;
      }
      next();
    });
    app.use(
      express.static(staticDirectory, {
        index: false,
        fallthrough: true,
        setHeaders: (response, filePath) => {
          if (contentHashedAsset(filePath, staticDirectory)) {
            response.setHeader(
              "Cache-Control",
              "public, max-age=31536000, immutable"
            );
          } else {
            response.setHeader("Cache-Control", "no-cache");
          }
        }
      })
    );

    app.use((req, res, next) => {
      const decodedPath = decodePathname(req.path);
      // SPA fallback 只服务无扩展名的 HTML 导航，静态资源/API 探测继续返回 404。
      const isHistoryNavigation =
        (req.method === "GET" || req.method === "HEAD") &&
        req.accepts("html") === "html" &&
        decodedPath !== undefined &&
        extname(decodedPath) === "" &&
        !hasDotSegment(decodedPath);
      if (!isHistoryNavigation) {
        next();
        return;
      }
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(
        "index.html",
        { root: staticDirectory, cacheControl: false },
        (error) => {
          if (error !== undefined) next(error);
        }
      );
    });
  }

  app.use((_req, _res, next) => {
    next(new HttpError("NOT_FOUND", 404, "接口不存在"));
  });
  app.use(createErrorHandler(log));

  return app;
};
