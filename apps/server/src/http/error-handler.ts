import type { ApiErrorResponse } from "@paper/shared";
import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

import { AuthError } from "../auth/auth-service.js";
import { DomainError } from "../infrastructure/domain-error.js";

export class HttpError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

interface ParserError extends Error {
  type?: string;
  status?: number;
  statusCode?: number;
}

export interface ServerErrorLogEntry {
  requestId: string;
  error: string;
  stack?: string;
}

export type ServerErrorLogger = (entry: ServerErrorLogEntry) => void;

const isInvalidJson = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const parserError = error as ParserError;
  return (
    parserError.type === "entity.parse.failed" ||
    parserError.type === "entity.too.large" ||
    parserError.status === 413 ||
    parserError.statusCode === 413
  );
};

export const createErrorHandler = (
  log: ServerErrorLogger
): ErrorRequestHandler => {
  return (error, req, res, _next) => {
    void _next;
    let status = 500;
    let code = "INTERNAL_ERROR";
    let message = "服务器内部错误";
    let unknownError = true;

    if (isInvalidJson(error) || error instanceof URIError) {
      unknownError = false;
      status = 400;
      code = "INVALID_JSON";
      message = "请求内容无法解析";
    } else if (error instanceof ZodError) {
      unknownError = false;
      status = 422;
      code = "VALIDATION_ERROR";
      message = "请求字段不合法";
    } else if (
      error instanceof AuthError ||
      error instanceof DomainError ||
      error instanceof HttpError
    ) {
      unknownError = false;
      status = error.status;
      code = error.code;
      message = error.message;
    }

    if (unknownError) {
      const entry: ServerErrorLogEntry = {
        requestId: req.requestId,
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error)
      };
      if (error instanceof Error && error.stack !== undefined) {
        entry.stack = error.stack;
      }
      try {
        log(entry);
      } catch {
        // Error logging cannot replace the safe HTTP failure response.
      }
    }

    const body: ApiErrorResponse = {
      error: { code, message, requestId: req.requestId }
    };
    res.status(status).json(body);
  };
};
