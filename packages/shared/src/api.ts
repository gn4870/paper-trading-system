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
  clientOrderId: z.string().uuid(),
  symbol: z.enum(SYMBOLS),
  side: z.enum(["BUY", "SELL"]),
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
