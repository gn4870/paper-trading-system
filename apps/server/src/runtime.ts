/**
 * 服务端组合根（composition root）与生命周期管理器。
 *
 * 所有内存状态和领域服务都在这里创建并连接；start 负责初始化行情、流动性、
 * WebSocket 和定时器，stop 则尽力释放所有资源并聚合清理错误。
 */
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";
import { join } from "node:path";

import { SYMBOLS } from "@paper/shared";
import type { Express } from "express";

import { AccountLedger } from "./accounts/account-ledger.js";
import { AuthService } from "./auth/auth-service.js";
import { createApp } from "./http/app.js";
import {
  EventJournal,
  type Clock,
  type IdGenerator
} from "./infrastructure/event-journal.js";
import { MemoryState } from "./infrastructure/memory-state.js";
import { LiquidityService } from "./liquidity/liquidity-service.js";
import { MarketCycle, type IntervalScheduler } from "./market/market-cycle.js";
import {
  MarketSimulator,
  type RandomSource
} from "./market/market-simulator.js";
import { OrderBook } from "./matching/order-book.js";
import { OrderService } from "./orders/order-service.js";
import {
  RealtimeHub,
  type RealtimeScheduler
} from "./realtime/realtime-hub.js";

export interface RuntimeTimers extends IntervalScheduler, RealtimeScheduler {}

export interface RuntimeOptions {
  clock?: Clock;
  ids?: IdGenerator;
  random?: RandomSource;
  timers?: RuntimeTimers;
  nowMs?: () => number;
  onTickError?: (error: unknown) => void;
  host?: string;
  webDistDir?: string;
}

export interface Runtime {
  state: MemoryState;
  ledger: AccountLedger;
  journal: EventJournal;
  orders: OrderService;
  market: MarketSimulator;
  liquidity: LiquidityService;
  marketCycle: MarketCycle;
  auth: AuthService;
  app: Express;
  httpServer: Server;
  realtime: RealtimeHub;
  start: (port?: number) => Promise<number>;
  stop: () => Promise<void>;
}

const defaultClock: Clock = { now: () => new Date().toISOString() };
const defaultIds: IdGenerator = { next: () => crypto.randomUUID() };
const defaultRandom: RandomSource = { next: () => Math.random() };
const defaultTimers: RuntimeTimers = {
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: (handle) =>
    globalThis.clearInterval(
      handle as ReturnType<typeof globalThis.setInterval>
    )
};

const hasWebDistShell = (directory: string): boolean => {
  try {
    return statSync(join(directory, "index.html")).isFile();
  } catch {
    return false;
  }
};

interface TestRuntimeDefaults {
  clock: Clock;
  ids: IdGenerator;
  random: RandomSource;
  webDistDir?: string;
}

const seedHash = (seed: string): number => {
  let hash = 2_166_136_261;
  for (const character of seed) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};

const testRuntimeDefaults = (): TestRuntimeDefaults | undefined => {
  // 确定性 ID、时钟和随机数只在显式 test 模式启用，绝不影响生产运行。
  const seed = process.env.PAPER_TEST_SEED;
  if (process.env.NODE_ENV !== "test" || seed === undefined) return undefined;
  if (seed.length === 0) throw new Error("PAPER_TEST_SEED must not be empty");

  const now = process.env.PAPER_TEST_NOW;
  if (now === undefined || !Number.isFinite(Date.parse(now))) {
    throw new Error("PAPER_TEST_NOW must be an ISO-8601 timestamp");
  }

  const prefix = seedHash(seed).toString(16).padStart(8, "0");
  let nextId = 0;
  const webDistDir = process.env.PAPER_TEST_WEB_DIST_DIR;
  return {
    clock: { now: () => now },
    ids: {
      next: () =>
        `${prefix}-0000-4000-8000-${(++nextId).toString(16).padStart(12, "0")}`
    },
    random: { next: () => 0.5 },
    ...(webDistDir === undefined ? {} : { webDistDir })
  };
};

const closeHttpServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
    server.closeAllConnections?.();
  });
};

const listen = async (
  server: Server,
  port: number,
  host: string
): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  return (server.address() as AddressInfo).port;
};

export const createRuntime = (options: RuntimeOptions = {}): Runtime => {
  const testDefaults = testRuntimeDefaults();
  const clock = options.clock ?? testDefaults?.clock ?? defaultClock;
  const ids = options.ids ?? testDefaults?.ids ?? defaultIds;
  const random = options.random ?? testDefaults?.random ?? defaultRandom;
  const timers = options.timers ?? defaultTimers;
  const nowMs = options.nowMs ?? Date.now;
  const onTickError =
    options.onTickError ??
    ((error: unknown) => console.error("Market tick failed", error));
  const host = options.host ?? "0.0.0.0";
  const configuredWebDistDir =
    options.webDistDir ??
    testDefaults?.webDistDir ??
    (process.env.NODE_ENV === "production"
      ? fileURLToPath(new URL("../../web/dist/", import.meta.url))
      : undefined);
  const webDistDir =
    configuredWebDistDir !== undefined && hasWebDistShell(configuredWebDistDir)
      ? configuredWebDistDir
      : undefined;
  let status: "new" | "starting" | "started" | "stopping" | "stopped" = "new";

  // 以下顺序体现依赖方向：基础状态 → 领域服务 → HTTP/WS 适配器。
  const state = new MemoryState();
  const ledger = new AccountLedger(state);
  const journal = new EventJournal(clock, ids);
  const isSystemUser = (userId: string): boolean =>
    state.users.get(userId)?.kind === "SYSTEM";
  for (const symbol of SYMBOLS) {
    state.books.set(symbol, new OrderBook(symbol, isSystemUser));
  }
  const orders = new OrderService(state, ledger, journal, clock, ids);
  const market = new MarketSimulator(state, journal, clock, random);
  const liquidity = new LiquidityService(state, ledger, orders, market, ids);
  const marketCycle = new MarketCycle(market, liquidity, timers, onTickError);
  const auth = new AuthService(state, ledger, clock, ids);
  const app = createApp({
    state,
    ledger,
    auth,
    orders,
    market,
    journal,
    requestIds: ids,
    ...(webDistDir === undefined ? {} : { staticDirectory: webDistDir }),
    marketLoopActive: () => status === "started"
  });
  const httpServer = createServer(app);
  const realtime = new RealtimeHub(auth, journal, {
    now: () => clock.now(),
    nowMs,
    scheduler: timers
  });

  let startPromise: Promise<number> | undefined;
  let stopPromise: Promise<void> | undefined;
  let boundPort: number | undefined;
  let stopRequested = false;

  const releaseResources = async (): Promise<void> => {
    const errors: unknown[] = [];
    const capture = (error: unknown): void => {
      if (error instanceof AggregateError) errors.push(...error.errors);
      else errors.push(error);
    };
    try {
      marketCycle.stop();
    } catch (error) {
      capture(error);
    }
    try {
      await realtime.stop();
    } catch (error) {
      capture(error);
    }
    try {
      await closeHttpServer(httpServer);
    } catch (error) {
      capture(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Runtime cleanup failed");
    }
  };

  const startOnce = async (port: number): Promise<number> => {
    status = "starting";
    try {
      // 首次监听前先完成一个完整 tick，保证页面一打开就有行情和可成交盘口。
      market.initialize();
      liquidity.initializeAccounts();
      marketCycle.tick();
      realtime.attach(httpServer);
      realtime.startHeartbeat();
      marketCycle.start();
      const listeningPort = await listen(httpServer, port, host);
      if (stopRequested) throw new Error("Runtime stopped during startup");
      boundPort = listeningPort;
      status = "started";
      return listeningPort;
    } catch (error) {
      status = "stopping";
      try {
        await releaseResources();
      } finally {
        status = "stopped";
      }
      throw error;
    }
  };

  const start = (port = 3000): Promise<number> => {
    if (stopRequested || status === "stopping" || status === "stopped") {
      return Promise.reject(new Error("Runtime is stopped"));
    }
    if (status === "started" && boundPort !== undefined) {
      return Promise.resolve(boundPort);
    }
    // 并发 start 调用共享同一个 Promise，避免重复创建监听器或定时器。
    if (startPromise !== undefined) return startPromise;
    if (status !== "new") {
      return Promise.reject(new Error("Runtime cannot be started"));
    }
    startPromise = startOnce(port);
    void startPromise.then(
      () => {
        startPromise = undefined;
      },
      () => {
        startPromise = undefined;
      }
    );
    return startPromise;
  };

  const stop = (): Promise<void> => {
    // stop 同样幂等；即使在启动过程中收到退出信号，也会等待并完整清理。
    if (stopPromise !== undefined) return stopPromise;
    stopRequested = true;
    stopPromise = (async () => {
      if (status === "stopped") return;
      if (status === "starting" && startPromise !== undefined) {
        try {
          await startPromise;
        } catch {
          return;
        }
      }
      status = "stopping";
      try {
        await releaseResources();
      } finally {
        status = "stopped";
      }
    })();
    return stopPromise;
  };

  return {
    state,
    ledger,
    journal,
    orders,
    market,
    liquidity,
    marketCycle,
    auth,
    app,
    httpServer,
    realtime,
    start,
    stop
  };
};
