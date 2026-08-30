import { ApiClientError } from "../api/http-client.js";

const errorMessages: Record<string, string> = {
  INSUFFICIENT_FUNDS: "可用资金不足，请降低价格或数量后重试。",
  INSUFFICIENT_POSITION: "可用持仓不足，请降低卖出数量后重试。",
  ORDER_NOT_ACTIVE: "该委托已结束，无法继续操作。",
  ORDER_NOT_FOUND: "未找到该委托，请等待数据同步后重试。",
  NETWORK_ERROR: "网络连接失败，请检查网络后重试。",
  UNAUTHORIZED: "登录状态已失效，请重新登录。"
};

export const commandErrorMessage = (
  error: unknown,
  fallback: string
): string => {
  if (error instanceof ApiClientError) {
    return errorMessages[error.code] ?? error.message ?? fallback;
  }
  return fallback;
};
