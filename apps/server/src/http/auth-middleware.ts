/**
 * Express 会话解析与路由鉴权中间件。
 * authenticateSession 只尝试恢复身份，不会拒绝匿名请求；真正需要登录的接口
 * 再显式挂载 requireAuth，从而让登录、注册和健康检查保持公开。
 */
import { parseCookie } from "cookie";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { AuthService, type AuthUser } from "../auth/auth-service.js";
import { HttpError } from "./error-handler.js";

export const SESSION_COOKIE = "paper_session";

declare global {
  // Express exposes this namespace specifically for application request merging.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: AuthUser;
      authSessionId?: string;
      requestId: string;
    }
  }
}

const sessionIdFrom = (request: Request): string | undefined => {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  try {
    const value = parseCookie(header)[SESSION_COOKIE];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
};

export const authenticateSession = (auth: AuthService): RequestHandler => {
  return (req, _res, next) => {
    const sessionId = sessionIdFrom(req);
    if (sessionId !== undefined) {
      const user = auth.resolveSession(sessionId);
      if (user !== undefined) {
        req.authSessionId = sessionId;
        req.authUser = user;
      }
    }
    next();
  };
};

export const requireAuth = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  if (req.authUser === undefined) {
    next(new HttpError("UNAUTHORIZED", 401, "请先登录"));
    return;
  }
  next();
};
