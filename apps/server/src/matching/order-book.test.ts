import type { Order, SymbolCode } from "@paper/shared";
import { describe, expect, it } from "vitest";

import { OrderBook } from "./order-book.js";

const order = (
  overrides: Partial<Order> &
    Pick<Order, "id" | "userId" | "side" | "limitPriceMinor" | "sequence">
): Order => {
  const quantity = overrides.originalQuantity ?? 100;
  return {
    id: overrides.id,
    clientOrderId: `client-${overrides.id}`,
    userId: overrides.userId,
    symbol: overrides.symbol ?? "AAPL",
    side: overrides.side,
    limitPriceMinor: overrides.limitPriceMinor,
    originalQuantity: quantity,
    remainingQuantity: overrides.remainingQuantity ?? quantity,
    status: overrides.status ?? "OPEN",
    sequence: overrides.sequence,
    createdAt: overrides.createdAt ?? "2026-08-29T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-08-29T00:00:00.000Z"
  };
};

describe("OrderBook", () => {
  it("matches best price before older worse price", () => {
    const book = new OrderBook("AAPL");
    book.submit(
      order({
        id: "sell-old",
        userId: "s1",
        side: "SELL",
        limitPriceMinor: 18_710,
        sequence: 1
      })
    );
    book.submit(
      order({
        id: "sell-best",
        userId: "s2",
        side: "SELL",
        limitPriceMinor: 18_700,
        sequence: 2
      })
    );

    const result = book.submit(
      order({
        id: "buy",
        userId: "b1",
        side: "BUY",
        limitPriceMinor: 18_720,
        sequence: 3
      })
    );

    expect(result.fills.map((fill) => fill.sellOrder.id)).toEqual([
      "sell-best"
    ]);
    expect(result.fills[0]?.executionPriceMinor).toBe(18_700);
  });

  it("matches older sequence first at the same price", () => {
    const book = new OrderBook("AAPL");
    book.submit(
      order({
        id: "s1",
        userId: "u1",
        side: "SELL",
        limitPriceMinor: 18_700,
        sequence: 1
      })
    );
    book.submit(
      order({
        id: "s2",
        userId: "u2",
        side: "SELL",
        limitPriceMinor: 18_700,
        sequence: 2
      })
    );

    const result = book.submit(
      order({
        id: "b1",
        userId: "u3",
        side: "BUY",
        limitPriceMinor: 18_700,
        originalQuantity: 150,
        sequence: 3
      })
    );

    expect(
      result.fills.map((fill) => [fill.sellOrder.id, fill.quantity])
    ).toEqual([
      ["s1", 100],
      ["s2", 50]
    ]);
  });

  it("cancels incoming remainder instead of self matching", () => {
    const book = new OrderBook("AAPL");
    book.submit(
      order({
        id: "s1",
        userId: "same",
        side: "SELL",
        limitPriceMinor: 18_700,
        sequence: 1
      })
    );

    const result = book.submit(
      order({
        id: "b1",
        userId: "same",
        side: "BUY",
        limitPriceMinor: 18_700,
        sequence: 2
      })
    );

    expect(result.selfTradePrevented).toBe(true);
    expect(result.incoming.status).toBe("CANCELED");
    expect(result.incoming.remainingQuantity).toBe(100);
    expect(result.fills).toHaveLength(0);
  });

  it("stops without a fill when the best opposing price does not cross", () => {
    const book = new OrderBook("AAPL");
    book.submit(
      order({
        id: "sell",
        userId: "s1",
        side: "SELL",
        limitPriceMinor: 18_701,
        sequence: 1
      })
    );

    const result = book.submit(
      order({
        id: "buy",
        userId: "b1",
        side: "BUY",
        limitPriceMinor: 18_700,
        sequence: 2
      })
    );

    expect(result.fills).toEqual([]);
    expect(result.incoming.status).toBe("OPEN");
    expect(book.get("buy")).toMatchObject({
      remainingQuantity: 100,
      status: "OPEN"
    });
  });

  it("executes at the resting maker price", () => {
    const book = new OrderBook("AAPL");
    book.submit(
      order({
        id: "buy-maker",
        userId: "b1",
        side: "BUY",
        limitPriceMinor: 18_720,
        sequence: 1
      })
    );

    const result = book.submit(
      order({
        id: "sell-taker",
        userId: "s1",
        side: "SELL",
        limitPriceMinor: 18_700,
        sequence: 2
      })
    );

    expect(result.fills).toMatchObject([
      { executionPriceMinor: 18_720, buyOrder: { id: "buy-maker" } }
    ]);
  });

  it("keeps a partially filled resting order ahead of later equal-price orders", () => {
    const book = new OrderBook("AAPL");
    book.submit(
      order({
        id: "first",
        userId: "s1",
        side: "SELL",
        limitPriceMinor: 18_700,
        sequence: 1
      })
    );
    book.submit(
      order({
        id: "second",
        userId: "s2",
        side: "SELL",
        limitPriceMinor: 18_700,
        sequence: 2
      })
    );
    book.submit(
      order({
        id: "partial-buyer",
        userId: "b1",
        side: "BUY",
        limitPriceMinor: 18_700,
        originalQuantity: 40,
        sequence: 3
      })
    );

    const result = book.submit(
      order({
        id: "next-buyer",
        userId: "b2",
        side: "BUY",
        limitPriceMinor: 18_700,
        sequence: 4
      })
    );

    expect(
      result.fills.map((fill) => [fill.sellOrder.id, fill.quantity])
    ).toEqual([
      ["first", 60],
      ["second", 40]
    ]);
    expect(book.get("first")).toBeUndefined();
    expect(book.get("second")).toMatchObject({ remainingQuantity: 60 });
  });

  it("matches one incoming order across multiple resting orders", () => {
    const book = new OrderBook("AAPL");
    book.submit(
      order({
        id: "s1",
        userId: "s1",
        side: "SELL",
        limitPriceMinor: 18_700,
        sequence: 1
      })
    );
    book.submit(
      order({
        id: "s2",
        userId: "s2",
        side: "SELL",
        limitPriceMinor: 18_710,
        sequence: 2
      })
    );

    const result = book.submit(
      order({
        id: "buy",
        userId: "b1",
        side: "BUY",
        limitPriceMinor: 18_720,
        originalQuantity: 150,
        sequence: 3
      })
    );

    expect(
      result.fills.map((fill) => [
        fill.sellOrder.id,
        fill.quantity,
        fill.executionPriceMinor
      ])
    ).toEqual([
      ["s1", 100, 18_700],
      ["s2", 50, 18_710]
    ]);
    expect(book.get("s2")).toMatchObject({
      remainingQuantity: 50,
      status: "PARTIALLY_FILLED"
    });
  });

  it("allows a system owner to match its own counter-order", () => {
    const book = new OrderBook("AAPL", (userId) => userId === "market-maker");
    book.submit(
      order({
        id: "sell",
        userId: "market-maker",
        side: "SELL",
        limitPriceMinor: 18_700,
        sequence: 1
      })
    );

    const result = book.submit(
      order({
        id: "buy",
        userId: "market-maker",
        side: "BUY",
        limitPriceMinor: 18_700,
        sequence: 2
      })
    );

    expect(result.selfTradePrevented).toBe(false);
    expect(result.fills).toHaveLength(1);
  });

  it("keeps symbol books independent by rejecting a different-symbol order", () => {
    const book = new OrderBook("AAPL");

    expect(() =>
      book.submit(
        order({
          id: "msft",
          userId: "u1",
          symbol: "MSFT" as SymbolCode,
          side: "BUY",
          limitPriceMinor: 100,
          sequence: 1
        })
      )
    ).toThrow();
  });

  it("returns defensive order snapshots from get, list, and remove", () => {
    const book = new OrderBook("AAPL");
    book.submit(
      order({
        id: "sell",
        userId: "s1",
        side: "SELL",
        limitPriceMinor: 18_700,
        sequence: 1
      })
    );

    const fromGet = book.get("sell");
    const fromList = book.ordersForUser("s1");
    expect(fromGet).toBeDefined();
    fromGet!.remainingQuantity = 1;
    fromList[0]!.remainingQuantity = 2;

    expect(book.get("sell")).toMatchObject({ remainingQuantity: 100 });
    const removed = book.remove("sell");
    removed!.remainingQuantity = 3;
    expect(removed).toMatchObject({ remainingQuantity: 3 });
    expect(book.get("sell")).toBeUndefined();
  });

  it("rejects terminal order input without mutating the book", () => {
    const book = new OrderBook("AAPL");
    const canceled = order({
      id: "canceled",
      userId: "u1",
      side: "BUY",
      limitPriceMinor: 100,
      sequence: 1,
      status: "CANCELED"
    });

    expect(() => book.submit(canceled)).toThrow();
    expect(book.ordersForUser("u1")).toEqual([]);
  });

  it("rejects zero remaining quantity input without mutating the book", () => {
    const book = new OrderBook("AAPL");
    const exhausted = order({
      id: "exhausted",
      userId: "u1",
      side: "BUY",
      limitPriceMinor: 100,
      remainingQuantity: 0,
      sequence: 1
    });

    expect(() => book.submit(exhausted)).toThrow();
    expect(book.ordersForUser("u1")).toEqual([]);
  });

  it("does not reserve an ID when input validation rejects the order", () => {
    const book = new OrderBook("AAPL");

    expect(() =>
      book.submit(
        order({
          id: "retryable",
          userId: "u1",
          side: "BUY",
          limitPriceMinor: 100,
          remainingQuantity: 0,
          sequence: 1
        })
      )
    ).toThrow();
    expect(() =>
      book.submit(
        order({
          id: "retryable",
          userId: "u1",
          side: "BUY",
          limitPriceMinor: 100,
          sequence: 1
        })
      )
    ).not.toThrow();
  });

  it("rejects an ID reused after its order is fully filled", () => {
    const book = new OrderBook("AAPL");
    book.submit(
      order({
        id: "filled",
        userId: "seller",
        side: "SELL",
        limitPriceMinor: 100,
        sequence: 1
      })
    );
    book.submit(
      order({
        id: "buyer",
        userId: "buyer",
        side: "BUY",
        limitPriceMinor: 100,
        sequence: 2
      })
    );

    expect(book.get("filled")).toBeUndefined();
    expect(() =>
      book.submit(
        order({
          id: "filled",
          userId: "other",
          side: "BUY",
          limitPriceMinor: 100,
          sequence: 3
        })
      )
    ).toThrow();
  });

  it("rejects an ID reused after self-trade prevention cancels it", () => {
    const book = new OrderBook("AAPL");
    book.submit(
      order({
        id: "resting",
        userId: "same",
        side: "SELL",
        limitPriceMinor: 100,
        sequence: 1
      })
    );
    book.submit(
      order({
        id: "stp-canceled",
        userId: "same",
        side: "BUY",
        limitPriceMinor: 100,
        sequence: 2
      })
    );

    expect(() =>
      book.submit(
        order({
          id: "stp-canceled",
          userId: "other",
          side: "BUY",
          limitPriceMinor: 100,
          sequence: 3
        })
      )
    ).toThrow();
  });

  it("rejects an ID reused after the order is removed", () => {
    const book = new OrderBook("AAPL");
    book.submit(
      order({
        id: "removed",
        userId: "u1",
        side: "BUY",
        limitPriceMinor: 100,
        sequence: 1
      })
    );
    book.remove("removed");

    expect(() =>
      book.submit(
        order({
          id: "removed",
          userId: "u2",
          side: "SELL",
          limitPriceMinor: 100,
          sequence: 2
        })
      )
    ).toThrow();
  });
});
