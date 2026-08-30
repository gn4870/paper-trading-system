import { describe, expect, it } from "vitest";
import * as memoryStateModule from "../infrastructure/memory-state.js";

import { AccountLedger } from "./account-ledger.js";
import { DomainError } from "../infrastructure/domain-error.js";
import { MemoryState } from "../infrastructure/memory-state.js";

describe("AccountLedger", () => {
  it("does not expose direct account-writing methods on memory state", () => {
    const state = new MemoryState();

    expect(state).not.toHaveProperty("createAccount");
    expect(state).not.toHaveProperty("replaceAccount");
  });

  it("does not export an account-writing capability from the memory-state API", () => {
    expect(memoryStateModule).not.toHaveProperty("getLedgerAccountStore");
  });

  it("creates a real account with starting cash and no shares", () => {
    const ledger = new AccountLedger(new MemoryState());

    expect(ledger.createRealAccount("buyer")).toEqual({
      userId: "buyer",
      cashAvailableMinor: 100_000_000,
      cashFrozenMinor: 0,
      positions: {
        AAPL: { availableQuantity: 0, frozenQuantity: 0 },
        MSFT: { availableQuantity: 0, frozenQuantity: 0 },
        TSLA: { availableQuantity: 0, frozenQuantity: 0 }
      }
    });
  });

  it("freezes buy funds and refunds price improvement", () => {
    const state = new MemoryState();
    const ledger = new AccountLedger(state);
    ledger.createRealAccount("buyer");
    ledger.seedSystemAccount("seller", 0, { AAPL: 1_000 });

    ledger.reserve({
      userId: "buyer",
      side: "BUY",
      symbol: "AAPL",
      limitPriceMinor: 18_720,
      quantity: 100
    });
    ledger.reserve({
      userId: "seller",
      side: "SELL",
      symbol: "AAPL",
      limitPriceMinor: 18_700,
      quantity: 100
    });
    ledger.settle({
      buyerId: "buyer",
      sellerId: "seller",
      symbol: "AAPL",
      buyLimitPriceMinor: 18_720,
      executionPriceMinor: 18_700,
      quantity: 100
    });

    expect(ledger.snapshot("buyer")).toMatchObject({
      cashAvailableMinor: 98_130_000,
      cashFrozenMinor: 0,
      positions: { AAPL: { availableQuantity: 100, frozenQuantity: 0 } }
    });
    expect(ledger.snapshot("seller")).toMatchObject({
      cashAvailableMinor: 1_870_000,
      cashFrozenMinor: 0,
      positions: { AAPL: { availableQuantity: 900, frozenQuantity: 0 } }
    });
  });

  it("releases only the remaining buy reservation", () => {
    const ledger = new AccountLedger(new MemoryState());
    ledger.seedSystemAccount("buyer", 1_000, {});
    ledger.seedSystemAccount("seller", 0, { AAPL: 10 });
    const reservation = {
      userId: "buyer",
      side: "BUY" as const,
      symbol: "AAPL" as const,
      limitPriceMinor: 100,
      quantity: 5
    };

    ledger.reserve(reservation);
    ledger.reserve({ ...reservation, userId: "seller", side: "SELL" });
    ledger.settle({
      buyerId: "buyer",
      sellerId: "seller",
      symbol: "AAPL",
      buyLimitPriceMinor: 100,
      executionPriceMinor: 90,
      quantity: 2
    });
    ledger.release({ ...reservation, quantity: 3 });

    expect(ledger.snapshot("buyer")).toMatchObject({
      cashAvailableMinor: 820,
      cashFrozenMinor: 0,
      positions: { AAPL: { availableQuantity: 2, frozenQuantity: 0 } }
    });
  });

  it("releases frozen sell shares back to the available position", () => {
    const ledger = new AccountLedger(new MemoryState());
    const reservation = {
      userId: "seller",
      side: "SELL" as const,
      symbol: "AAPL" as const,
      limitPriceMinor: 100,
      quantity: 3
    };
    ledger.seedSystemAccount("seller", 0, { AAPL: 3 });

    ledger.reserve(reservation);
    ledger.release(reservation);

    expect(ledger.snapshot("seller").positions.AAPL).toEqual({
      availableQuantity: 3,
      frozenQuantity: 0
    });
  });

  it("does not settle either account when seller cash would overflow", () => {
    const ledger = new AccountLedger(new MemoryState());
    ledger.seedSystemAccount("buyer", 10, {});
    ledger.seedSystemAccount("seller", Number.MAX_SAFE_INTEGER, { AAPL: 1 });
    ledger.reserve({
      userId: "buyer",
      side: "BUY",
      symbol: "AAPL",
      limitPriceMinor: 1,
      quantity: 1
    });
    ledger.reserve({
      userId: "seller",
      side: "SELL",
      symbol: "AAPL",
      limitPriceMinor: 1,
      quantity: 1
    });

    expect(() =>
      ledger.settle({
        buyerId: "buyer",
        sellerId: "seller",
        symbol: "AAPL",
        buyLimitPriceMinor: 1,
        executionPriceMinor: 1,
        quantity: 1
      })
    ).toThrowError(
      new DomainError("INVARIANT_VIOLATION", 500, "账户状态不合法")
    );
    expect(ledger.snapshot("buyer")).toMatchObject({
      cashAvailableMinor: 9,
      cashFrozenMinor: 1,
      positions: { AAPL: { availableQuantity: 0, frozenQuantity: 0 } }
    });
    expect(ledger.snapshot("seller")).toMatchObject({
      cashAvailableMinor: Number.MAX_SAFE_INTEGER,
      positions: { AAPL: { availableQuantity: 0, frozenQuantity: 1 } }
    });
  });

  it("accepts sell reservations when a safe price and quantity have an unsafe product", () => {
    const ledger = new AccountLedger(new MemoryState());
    const sell = {
      userId: "seller",
      side: "SELL" as const,
      symbol: "AAPL" as const,
      limitPriceMinor: Number.MAX_SAFE_INTEGER,
      quantity: 2
    };
    ledger.seedSystemAccount("seller", 0, { AAPL: 2 });

    ledger.reserve(sell);
    expect(ledger.snapshot("seller").positions.AAPL).toEqual({
      availableQuantity: 0,
      frozenQuantity: 2
    });
    ledger.release(sell);
    expect(ledger.snapshot("seller").positions.AAPL).toEqual({
      availableQuantity: 2,
      frozenQuantity: 0
    });
  });

  it("rejects unknown runtime order sides and symbols with domain errors", () => {
    const ledger = new AccountLedger(new MemoryState());
    ledger.createRealAccount("buyer");

    expect(() =>
      ledger.reserve({
        userId: "buyer",
        side: "HOLD" as never,
        symbol: "AAPL",
        limitPriceMinor: 1,
        quantity: 1
      })
    ).toThrowError(
      new DomainError("INVARIANT_VIOLATION", 500, "交易方向不合法")
    );
    expect(() =>
      ledger.release({
        userId: "buyer",
        side: "BUY",
        symbol: "NVDA" as never,
        limitPriceMinor: 1,
        quantity: 1
      })
    ).toThrowError(
      new DomainError("INVARIANT_VIOLATION", 500, "股票代码不合法")
    );
    expect(() =>
      ledger.settle({
        buyerId: "buyer",
        sellerId: "seller",
        symbol: "NVDA" as never,
        buyLimitPriceMinor: 1,
        executionPriceMinor: 1,
        quantity: 1
      })
    ).toThrowError(
      new DomainError("INVARIANT_VIOLATION", 500, "股票代码不合法")
    );
  });

  it("rejects a sell reservation without shares", () => {
    const ledger = new AccountLedger(new MemoryState());
    ledger.createRealAccount("seller");

    expect(() =>
      ledger.reserve({
        userId: "seller",
        side: "SELL",
        symbol: "AAPL",
        limitPriceMinor: 18_700,
        quantity: 1
      })
    ).toThrowError(
      new DomainError("INSUFFICIENT_POSITION", 409, "可用持仓不足")
    );
  });

  it("rejects unsafe monetary values without mutating the account", () => {
    const ledger = new AccountLedger(new MemoryState());
    ledger.createRealAccount("buyer");

    expect(() =>
      ledger.reserve({
        userId: "buyer",
        side: "BUY",
        symbol: "AAPL",
        limitPriceMinor: Number.MAX_SAFE_INTEGER,
        quantity: 2
      })
    ).toThrowError(
      new DomainError("INVARIANT_VIOLATION", 500, "账户状态不合法")
    );
    expect(ledger.snapshot("buyer").cashAvailableMinor).toBe(100_000_000);
  });
});
