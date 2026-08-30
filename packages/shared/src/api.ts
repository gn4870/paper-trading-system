/**
 * REST 命令的运行时校验契约。
 * TypeScript 类型只在编译期生效，网络请求仍是不可信输入，所以服务端必须用
 * Zod 再校验一次；前端也复用由 schema 推导出的请求类型。
 */
import { z } from "zod";

import { SYMBOLS } from "./domain.js";

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,32}$/);
const passwordSchema = z.string().min(8).max(72);

export const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema
});

export const loginSchema = z.object({
  username: usernameSchema,
  password: passwordSchema
});

export const placeOrderSchema = z.object({
  // clientOrderId 由客户端为一次下单意图生成，服务端用它实现幂等重试。
  clientOrderId: z.string().uuid(),
  symbol: z.enum(SYMBOLS),
  side: z.enum(["BUY", "SELL"]),
  // 价格以“分”传输，并限制为安全整数，避免金额计算溢出或浮点漂移。
  limitPriceMinor: z.number().int().safe().positive(),
  quantity: z.number().int().safe().positive()
});

export type RegisterRequest = z.infer<typeof registerSchema>;
export type LoginRequest = z.infer<typeof loginSchema>;
export type PlaceOrderRequest = z.infer<typeof placeOrderSchema>;

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}
