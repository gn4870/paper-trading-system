import type { LoginRequest } from "@paper/shared";

import { ApiClientError } from "../api/http-client.js";

export const validateCredentials = (input: LoginRequest): string | null => {
  if (!/^[a-z0-9_]{3,32}$/.test(input.username)) {
    return "用户名需为 3–32 位小写字母、数字或下划线。";
  }
  if (input.password.length < 8 || input.password.length > 72) {
    return "密码长度需为 8–72 位。";
  }
  return null;
};

export const executableErrorMessage = (error: unknown): string =>
  error instanceof ApiClientError
    ? error.message
    : "操作未完成，请检查网络后重试。";
