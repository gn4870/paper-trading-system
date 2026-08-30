import { describe, expect, it } from "vitest";
import { loginSchema, placeOrderSchema, registerSchema } from "./api.js";

describe("shared API schemas", () => {
  it("normalizes registration", () => {
    const result = registerSchema.parse({
      username: "  Trader_01 ",
      password: "safe-pass-123"
    });

    expect(result.username).toBe("trader_01");
  });

  it("rejects zero prices", () => {
    expect(() =>
      placeOrderSchema.parse({
        clientOrderId: crypto.randomUUID(),
        symbol: "AAPL",
        side: "BUY",
        limitPriceMinor: 0,
        quantity: 1
      })
    ).toThrow();
  });

  it("rejects fractional quantities", () => {
    expect(() =>
      placeOrderSchema.parse({
        clientOrderId: crypto.randomUUID(),
        symbol: "AAPL",
        side: "BUY",
        limitPriceMinor: 1,
        quantity: 1.5
      })
    ).toThrow();
  });

  it("accepts the password lower boundary", () => {
    expect(
      loginSchema.parse({ username: "trader_01", password: "12345678" })
    ).toEqual({
      username: "trader_01",
      password: "12345678"
    });
  });
});
