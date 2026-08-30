import type {
  AccountSnapshot,
  BootstrapResponse,
  BusinessServerEvent,
  Order,
  StockQuote,
  Trade
} from "@paper/shared";
import { describe, expect, it } from "vitest";

import { createTradingStoreHarness } from "./trading-store.js";

const accountFixture = (cashAvailableMinor = 1_000_000): AccountSnapshot => ({
  userId: "user-1",
  cashAvailableMinor,
  cashFrozenMinor: 0,
  positions: {
    AAPL: { availableQuantity: 1, frozenQuantity: 0 },
    MSFT: { availableQuantity: 2, frozenQuantity: 0 },
    TSLA: { availableQuantity: 3, frozenQuantity: 0 }
  }
});

const quoteFixture = (
  symbol: StockQuote["symbol"],
  lastPriceMinor = 10_000
): StockQuote => ({
  symbol,
  name: symbol,
  openPriceMinor: 9_900,
  lastPriceMinor,
  changePercent: 1.01,
  bestBidMinor: 9_999,
  bestAskMinor: 10_001,
  history: [{ priceMinor: lastPriceMinor, at: "2026-08-29T00:00:00.000Z" }]
});

const orderFixture = (
  id: string,
  sequence: number,
  status: Order["status"] = "OPEN"
): Order => ({
  id,
  clientOrderId: `client-${id}`,
  userId: "user-1",
  symbol: "AAPL",
  side: "BUY",
  limitPriceMinor: 10_000,
  originalQuantity: 10,
  remainingQuantity: status === "FILLED" ? 0 : 10,
  status,
  sequence,
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z"
});

const tradeFixture = (id: string, sequence: number): Trade => ({
  id,
  symbol: "AAPL",
  buyOrderId: "buy-1",
  sellOrderId: "sell-1",
  buyerId: "user-1",
  sellerId: "user-2",
  priceMinor: 10_000,
  quantity: 1,
  executedAt: "2026-08-29T00:00:00.000Z",
  sequence
});

const bootstrapFixture = (stateVersion = 12): BootstrapResponse => ({
  user: { id: "user-1", username: "trader_01" },
  account: accountFixture(),
  stocks: [quoteFixture("TSLA"), quoteFixture("AAPL"), quoteFixture("MSFT")],
  orders: [
    orderFixture("order-1", 1),
    orderFixture("order-3", 3),
    orderFixture("order-2", 2)
  ],
  trades: [tradeFixture("trade-1", 1)],
  stateVersion
});

const event = <T extends BusinessServerEvent>(value: T): T => value;

describe("trading store", () => {
  it("fully replaces state from a defensive bootstrap snapshot", () => {
    const store = createTradingStoreHarness();
    store.applyEvent(
      event({
        type: "market.updated",
        eventId: "old-event",
        stateVersion: 1,
        occurredAt: "2026-08-29T00:00:00.000Z",
        payload: quoteFixture("AAPL", 8_888)
      })
    );
    const snapshot = bootstrapFixture();

    store.replaceSnapshot(snapshot);
    snapshot.stocks[0]!.lastPriceMinor = 1;
    snapshot.account.positions.AAPL.availableQuantity = 999;
    snapshot.orders[0]!.status = "FILLED";

    expect(store.stateVersion).toBe(12);
    expect(store.stocks.map(({ symbol }) => symbol)).toEqual([
      "AAPL",
      "MSFT",
      "TSLA"
    ]);
    expect(
      store.stocks.find(({ symbol }) => symbol === "TSLA")?.lastPriceMinor
    ).toBe(10_000);
    expect(store.account?.positions.AAPL.availableQuantity).toBe(1);
    expect(store.orders.map(({ id }) => id)).toEqual([
      "order-3",
      "order-2",
      "order-1"
    ]);
    expect(store.orders.find(({ id }) => id === "order-1")?.status).toBe(
      "OPEN"
    );
    expect(store.appliedEventIds).toEqual([]);
  });

  it("upserts each business payload while requiring a strictly newer version", () => {
    const store = createTradingStoreHarness();
    store.replaceSnapshot(bootstrapFixture());

    store.applyEvent(
      event({
        type: "market.updated",
        eventId: "event-13",
        stateVersion: 13,
        occurredAt: "2026-08-29T00:00:01.000Z",
        payload: quoteFixture("AAPL", 10_500)
      })
    );
    store.applyEvent(
      event({
        type: "order.updated",
        eventId: "event-14",
        stateVersion: 14,
        occurredAt: "2026-08-29T00:00:02.000Z",
        payload: orderFixture("order-2", 2, "FILLED")
      })
    );
    store.applyEvent(
      event({
        type: "account.updated",
        eventId: "event-15",
        stateVersion: 15,
        occurredAt: "2026-08-29T00:00:03.000Z",
        payload: accountFixture(750_000)
      })
    );
    store.applyEvent(
      event({
        type: "trade.created",
        eventId: "event-16",
        stateVersion: 16,
        occurredAt: "2026-08-29T00:00:04.000Z",
        payload: tradeFixture("trade-2", 2)
      })
    );
    store.applyEvent(
      event({
        type: "account.updated",
        eventId: "event-15-duplicate-version",
        stateVersion: 15,
        occurredAt: "2026-08-29T00:00:05.000Z",
        payload: accountFixture(1)
      })
    );

    expect(store.stateVersion).toBe(16);
    expect(
      store.stocks.find(({ symbol }) => symbol === "AAPL")?.lastPriceMinor
    ).toBe(10_500);
    expect(store.orders.find(({ id }) => id === "order-2")?.status).toBe(
      "FILLED"
    );
    expect(store.account?.cashAvailableMinor).toBe(750_000);
    expect(store.trades.map(({ id }) => id)).toEqual(["trade-2", "trade-1"]);
    expect(store.appliedEventIds).not.toContain("event-15-duplicate-version");
  });

  it("ignores duplicate event IDs and non-business protocol messages", () => {
    const store = createTradingStoreHarness();
    store.replaceSnapshot(bootstrapFixture());
    const update = event({
      type: "order.updated",
      eventId: "event-13",
      stateVersion: 13,
      occurredAt: "2026-08-29T00:00:01.000Z",
      payload: orderFixture("order-1", 1, "FILLED")
    });

    store.applyEvent(update);
    store.applyEvent({
      ...update,
      stateVersion: 14,
      payload: orderFixture("order-1", 1, "OPEN")
    });
    store.applyEvent({
      type: "heartbeat",
      occurredAt: "2026-08-29T00:00:02.000Z"
    });
    store.applyEvent({
      type: "connection.ready",
      stateVersion: 999,
      occurredAt: "2026-08-29T00:00:03.000Z"
    });

    expect(store.stateVersion).toBe(13);
    expect(store.orders[2]?.status).toBe("FILLED");
    expect(store.appliedEventIds).toEqual(["event-13"]);
  });

  it("deduplicates one private trade delivered for both counterparties while advancing version", () => {
    const store = createTradingStoreHarness();
    store.replaceSnapshot(bootstrapFixture());
    const trade = tradeFixture("shared-trade", 2);

    store.applyEvent(
      event({
        type: "trade.created",
        eventId: "buyer-event",
        stateVersion: 13,
        occurredAt: "2026-08-29T00:00:01.000Z",
        payload: trade
      })
    );
    store.applyEvent(
      event({
        type: "trade.created",
        eventId: "seller-event",
        stateVersion: 14,
        occurredAt: "2026-08-29T00:00:02.000Z",
        payload: { ...trade }
      })
    );

    expect(store.stateVersion).toBe(14);
    expect(store.trades.filter(({ id }) => id === "shared-trade")).toHaveLength(
      1
    );
    expect(store.appliedEventIds).toEqual(["buyer-event", "seller-event"]);
  });

  it("retains only the newest 50 unique trades", () => {
    const store = createTradingStoreHarness();
    store.replaceSnapshot({ ...bootstrapFixture(0), trades: [] });

    for (let sequence = 1; sequence <= 55; sequence += 1) {
      store.applyEvent(
        event({
          type: "trade.created",
          eventId: `event-${sequence}`,
          stateVersion: sequence,
          occurredAt: "2026-08-29T00:00:00.000Z",
          payload: tradeFixture(`trade-${sequence}`, sequence)
        })
      );
    }

    expect(store.trades).toHaveLength(50);
    expect(store.trades[0]?.id).toBe("trade-55");
    expect(store.trades.at(-1)?.id).toBe("trade-6");
  });
});
