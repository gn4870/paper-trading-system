import { placeOrderSchema, type PlaceOrderRequest } from "@paper/shared";
import { describe, expect, it } from "vitest";

import { AccountLedger } from "../accounts/account-ledger.js";
import {
  type Clock,
  EventJournal,
  type IdGenerator
} from "../infrastructure/event-journal.js";
import {
  MemoryState,
  type UserRecord
} from "../infrastructure/memory-state.js";
import {
  MarketSimulator,
  type RandomSource
} from "../market/market-simulator.js";
import { MarketCycle } from "../market/market-cycle.js";
import { OrderService } from "../orders/order-service.js";
import {
  LiquidityService,
  SYSTEM_MARKET_BUYER_ID,
  SYSTEM_MARKET_SELLER_ID
} from "./liquidity-service.js";

const instant = "2026-08-29T00:00:00.000Z";

const request = (
  side: PlaceOrderRequest["side"],
  limitPriceMinor: number,
  quantity: number,
  clientOrderId: string,
  symbol: PlaceOrderRequest["symbol"] = "AAPL"
): PlaceOrderRequest => ({
  clientOrderId,
  symbol,
  side,
  limitPriceMinor,
  quantity
});

const user = (id: string, kind: UserRecord["kind"]): UserRecord => ({
  id,
  username: id,
  normalizedUsername: id,
  passwordDigest: "test-only",
  kind
});

const createLiquidityHarness = () => {
  const state = new MemoryState();
  const ledger = new AccountLedger(state);
  const clock: Clock = { now: () => instant };
  let nextId = 0;
  const ids: IdGenerator = { next: () => `id-${++nextId}` };
  const journal = new EventJournal(clock, ids);
  const service = new OrderService(state, ledger, journal, clock, ids);
  const random: RandomSource = { next: () => 0.5 };
  const market = new MarketSimulator(state, journal, clock, random);
  market.initialize();
  let nextUuid = 0;
  const uuids = {
    next: () =>
      `00000000-0000-4000-8000-${(++nextUuid).toString(16).padStart(12, "0")}`
  };
  const liquidity = new LiquidityService(state, ledger, service, market, uuids);
  const cycle = new MarketCycle(market, liquidity);

  const addUser = (
    id: string,
    cashMinor = 100_000_000,
    aaplQuantity = 0
  ): void => {
    state.users.set(id, user(id, "REAL"));
    ledger.seedSystemAccount(id, cashMinor, { AAPL: aaplQuantity });
  };

  return { state, ledger, service, market, liquidity, cycle, addUser };
};

describe("LiquidityService", () => {
  it("creates three non-crossing levels per side with specified sizes", () => {
    const h = createLiquidityHarness();
    h.liquidity.initializeAccounts();

    h.liquidity.refreshAll();

    const orders = h.service.listSystemOrders("AAPL");
    const buys = orders.filter((order) => order.side === "BUY");
    const sells = orders.filter((order) => order.side === "SELL");
    expect(
      buys.map((order) => [order.limitPriceMinor, order.originalQuantity])
    ).toEqual([
      [18_681, 100],
      [18_663, 200],
      [18_644, 300]
    ]);
    expect(
      sells.map((order) => [order.limitPriceMinor, order.originalQuantity])
    ).toEqual([
      [18_719, 100],
      [18_737, 200],
      [18_756, 300]
    ]);
    expect(
      Math.max(...buys.map((order) => order.limitPriceMinor))
    ).toBeLessThan(Math.min(...sells.map((order) => order.limitPriceMinor)));
  });

  it("uses injected UUIDs accepted by the shared place-order contract", () => {
    const h = createLiquidityHarness();
    h.liquidity.initializeAccounts();

    h.liquidity.refreshAll();

    const systemOrders = [...h.state.orders.values()].filter((order) =>
      [SYSTEM_MARKET_BUYER_ID, SYSTEM_MARKET_SELLER_ID].includes(order.userId)
    );
    expect(systemOrders).toHaveLength(18);
    expect(
      systemOrders.every(
        (order) =>
          placeOrderSchema.safeParse({
            clientOrderId: order.clientOrderId,
            symbol: order.symbol,
            side: order.side,
            limitPriceMinor: order.limitPriceMinor,
            quantity: order.originalQuantity
          }).success
      )
    ).toBe(true);
  });

  it("seeds safe assets for at least five years of continuous opening-price refreshes", () => {
    const h = createLiquidityHarness();
    h.liquidity.initializeAccounts();

    const buyer = h.ledger.snapshot(SYSTEM_MARKET_BUYER_ID);
    const seller = h.ledger.snapshot(SYSTEM_MARKET_SELLER_ID);
    const fiveYearsInSeconds = 5 * 365 * 24 * 60 * 60;
    const allOpeningBidsCostPerSecond =
      18_681 * 100 +
      18_663 * 200 +
      18_644 * 300 +
      42_557 * 100 +
      42_515 * 200 +
      42_472 * 300 +
      24_376 * 100 +
      24_351 * 200 +
      24_327 * 300;

    expect(
      buyer.cashAvailableMinor / allOpeningBidsCostPerSecond
    ).toBeGreaterThan(fiveYearsInSeconds);
    for (const symbol of ["AAPL", "MSFT", "TSLA"] as const) {
      expect(
        seller.positions[symbol].availableQuantity / (100 + 200 + 300)
      ).toBeGreaterThan(fiveYearsInSeconds);
    }
    expect(Number.isSafeInteger(buyer.cashAvailableMinor)).toBe(true);
    expect(
      Object.values(seller.positions).every((position) =>
        Number.isSafeInteger(position.availableQuantity)
      )
    ).toBe(true);
  });

  it("keeps old orders and accounts unchanged when seller inventory cannot cover a refresh", () => {
    const h = createLiquidityHarness();
    for (const symbol of ["AAPL", "MSFT", "TSLA"] as const) {
      const quote = h.state.quotes.get(symbol)!;
      h.state.quotes.set(symbol, {
        ...quote,
        lastPriceMinor: 1,
        history: [{ priceMinor: 1, at: instant }]
      });
    }
    h.liquidity.initializeAccounts();
    h.liquidity.refreshAll();
    const seller = h.ledger.snapshot(SYSTEM_MARKET_SELLER_ID);
    const sellable = seller.positions.AAPL.availableQuantity;
    h.addUser("inventory-drainer", sellable + 1_000);
    const drain = h.service.place(
      SYSTEM_MARKET_SELLER_ID,
      request("SELL", 1, sellable, "00000000-0000-4000-8000-100000000001")
    );
    h.service.place(
      "inventory-drainer",
      request(
        "BUY",
        1,
        drain.order.remainingQuantity,
        "00000000-0000-4000-8000-100000000002"
      )
    );
    h.service.place(
      "inventory-drainer",
      request("BUY", 2, 100, "00000000-0000-4000-8000-100000000003")
    );
    const oldOrders = h.service.listSystemOrders();
    const orderCount = h.state.orders.size;
    const ordersBefore = structuredClone([...h.state.orders]);
    const idempotencyBefore = structuredClone([...h.state.idempotency]);
    const tradesBefore = structuredClone(h.state.trades);
    const sequencesBefore = [
      h.state.nextOrderSequence,
      h.state.nextTradeSequence
    ];
    const buyerBefore = h.ledger.snapshot(SYSTEM_MARKET_BUYER_ID);
    const sellerBefore = h.ledger.snapshot(SYSTEM_MARKET_SELLER_ID);

    expect(
      sellerBefore.positions.AAPL.availableQuantity +
        sellerBefore.positions.AAPL.frozenQuantity
    ).toBe(500);
    expect(() => h.liquidity.refreshAll()).toThrow();
    expect(h.state.orders.size).toBe(orderCount);
    expect([...h.state.orders]).toEqual(ordersBefore);
    expect([...h.state.idempotency]).toEqual(idempotencyBefore);
    expect(h.state.trades).toEqual(tradesBefore);
    expect([h.state.nextOrderSequence, h.state.nextTradeSequence]).toEqual(
      sequencesBefore
    );
    expect(h.service.listSystemOrders()).toEqual(oldOrders);
    expect(h.ledger.snapshot(SYSTEM_MARKET_BUYER_ID)).toEqual(buyerBefore);
    expect(h.ledger.snapshot(SYSTEM_MARKET_SELLER_ID)).toEqual(sellerBefore);
  });

  it("keeps old orders and accounts unchanged when buyer cash cannot cover a refresh", () => {
    const h = createLiquidityHarness();
    for (const symbol of ["AAPL", "MSFT", "TSLA"] as const) {
      const quote = h.state.quotes.get(symbol)!;
      h.state.quotes.set(symbol, {
        ...quote,
        lastPriceMinor: 1,
        history: [{ priceMinor: 1, at: instant }]
      });
    }
    h.liquidity.initializeAccounts();
    h.liquidity.refreshAll();
    h.state.users.set("bid-drainer", user("bid-drainer", "REAL"));
    h.ledger.seedSystemAccount("bid-drainer", 0, {
      AAPL: 600,
      MSFT: 600,
      TSLA: 600
    });
    for (const symbol of ["AAPL", "MSFT", "TSLA"] as const) {
      h.service.place(
        "bid-drainer",
        request(
          "SELL",
          1,
          600,
          `00000000-0000-4000-8000-20000000000${symbol === "AAPL" ? 1 : symbol === "MSFT" ? 2 : 3}`,
          symbol
        )
      );
    }
    const availableCash = h.ledger.snapshot(
      SYSTEM_MARKET_BUYER_ID
    ).cashAvailableMinor;
    const drainQuantity = Math.floor(availableCash / 3);
    h.state.users.set("cash-drainer", user("cash-drainer", "REAL"));
    h.ledger.seedSystemAccount("cash-drainer", 0, {
      AAPL: drainQuantity
    });
    h.service.place(
      "cash-drainer",
      request("SELL", 3, drainQuantity, "00000000-0000-4000-8000-200000000004")
    );
    h.service.place(
      SYSTEM_MARKET_BUYER_ID,
      request("BUY", 3, drainQuantity, "00000000-0000-4000-8000-200000000005")
    );
    const oldOrders = h.service.listSystemOrders();
    const orderCount = h.state.orders.size;
    const ordersBefore = structuredClone([...h.state.orders]);
    const idempotencyBefore = structuredClone([...h.state.idempotency]);
    const tradesBefore = structuredClone(h.state.trades);
    const sequencesBefore = [
      h.state.nextOrderSequence,
      h.state.nextTradeSequence
    ];
    const buyerBefore = h.ledger.snapshot(SYSTEM_MARKET_BUYER_ID);
    const sellerBefore = h.ledger.snapshot(SYSTEM_MARKET_SELLER_ID);

    expect(
      buyerBefore.cashAvailableMinor + buyerBefore.cashFrozenMinor
    ).toBeLessThan(1_800);
    expect(() => h.liquidity.refreshAll()).toThrow();
    expect(h.state.orders.size).toBe(orderCount);
    expect([...h.state.orders]).toEqual(ordersBefore);
    expect([...h.state.idempotency]).toEqual(idempotencyBefore);
    expect(h.state.trades).toEqual(tradesBefore);
    expect([h.state.nextOrderSequence, h.state.nextTradeSequence]).toEqual(
      sequencesBefore
    );
    expect(h.service.listSystemOrders()).toEqual(oldOrders);
    expect(h.ledger.snapshot(SYSTEM_MARKET_BUYER_ID)).toEqual(buyerBefore);
    expect(h.ledger.snapshot(SYSTEM_MARKET_SELLER_ID)).toEqual(sellerBefore);
  });

  it("keeps bid and ask at least one minor unit apart after rounding", () => {
    const h = createLiquidityHarness();
    const aapl = h.state.quotes.get("AAPL")!;
    h.state.quotes.set("AAPL", {
      ...aapl,
      lastPriceMinor: 1,
      history: [{ priceMinor: 1, at: instant }]
    });
    h.liquidity.initializeAccounts();

    h.liquidity.refreshAll();

    const orders = h.service.listSystemOrders("AAPL");
    expect(
      Math.max(
        ...orders
          .filter((order) => order.side === "BUY")
          .map((order) => order.limitPriceMinor)
      )
    ).toBe(1);
    expect(
      Math.min(
        ...orders
          .filter((order) => order.side === "SELL")
          .map((order) => order.limitPriceMinor)
      )
    ).toBe(2);
  });

  it("fills a real buy at the replenished best ask", () => {
    const h = createLiquidityHarness();
    h.addUser("real-buyer");
    h.liquidity.initializeAccounts();
    h.liquidity.refreshAll();
    h.market.setBestPrices();
    const quote = h.market
      .snapshots()
      .find((value) => value.symbol === "AAPL")!;

    const result = h.service.place(
      "real-buyer",
      request("BUY", quote.bestAskMinor!, 100, "liquid-buy")
    );

    expect(result.order.status).toBe("FILLED");
    expect(result.trades[0]).toMatchObject({
      sellerId: SYSTEM_MARKET_SELLER_ID,
      priceMinor: 18_719,
      quantity: 100
    });
  });

  it("does not grant a later system order priority at the same price", () => {
    const h = createLiquidityHarness();
    h.addUser("real-seller", 0, 100);
    h.addUser("real-buyer");
    h.service.place(
      "real-seller",
      request("SELL", 18_719, 100, "real-resting-sell")
    );
    h.liquidity.initializeAccounts();
    h.liquidity.refreshAll();

    const result = h.service.place(
      "real-buyer",
      request("BUY", 18_719, 100, "real-crossing-buy")
    );

    expect(result.trades[0]?.sellerId).toBe("real-seller");
  });

  it("refreshes after system fills and cancels without touching real orders", () => {
    const h = createLiquidityHarness();
    h.addUser("real-buyer");
    h.liquidity.initializeAccounts();
    h.liquidity.refreshAll();
    const [filled, canceled] = h.service
      .listSystemOrders("AAPL")
      .filter((order) => order.side === "SELL");
    h.service.place(
      "real-buyer",
      request("BUY", filled!.limitPriceMinor, 100, "fill-old-system")
    );
    h.service.cancel(canceled!.userId, canceled!.id);
    const realOrder = h.service.place(
      "real-buyer",
      request("BUY", 1, 1, "persistent-real-order")
    ).order;

    expect(() => h.liquidity.refreshAll()).not.toThrow();
    expect(h.service.listForUser("real-buyer")).toContainEqual(
      expect.objectContaining({ id: realOrder.id, status: "OPEN" })
    );
    expect(h.service.listSystemOrders("AAPL")).toHaveLength(6);
  });

  it("uses unique client IDs and preserves safe system-account assets", () => {
    const h = createLiquidityHarness();
    h.addUser("real-trader");
    h.liquidity.initializeAccounts();
    h.liquidity.initializeAccounts();
    const initialCash =
      h.ledger.snapshot(SYSTEM_MARKET_BUYER_ID).cashAvailableMinor +
      h.ledger.snapshot(SYSTEM_MARKET_SELLER_ID).cashAvailableMinor +
      h.ledger.snapshot("real-trader").cashAvailableMinor;
    h.liquidity.refreshAll();
    h.market.setBestPrices();
    const quote = h.market.snapshots()[0]!;
    h.service.place(
      "real-trader",
      request("BUY", quote.bestAskMinor!, 100, "asset-buy")
    );
    h.service.place(
      "real-trader",
      request("SELL", quote.bestBidMinor!, 100, "asset-sell")
    );

    h.liquidity.refreshAll();

    const allSystemOrders = [...h.state.orders.values()].filter((order) =>
      [SYSTEM_MARKET_BUYER_ID, SYSTEM_MARKET_SELLER_ID].includes(order.userId)
    );
    expect(
      new Set(allSystemOrders.map((order) => order.clientOrderId)).size
    ).toBe(allSystemOrders.length);
    const accounts = [
      h.ledger.snapshot(SYSTEM_MARKET_BUYER_ID),
      h.ledger.snapshot(SYSTEM_MARKET_SELLER_ID),
      h.ledger.snapshot("real-trader")
    ];
    expect(
      accounts.reduce(
        (sum, account) =>
          sum + account.cashAvailableMinor + account.cashFrozenMinor,
        0
      )
    ).toBe(initialCash);
    expect(
      accounts.reduce(
        (sum, account) =>
          sum +
          account.positions.AAPL.availableQuantity +
          account.positions.AAPL.frozenQuantity,
        0
      )
    ).toBe(1_000_000_000_000);
    for (const account of accounts) {
      expect(Number.isSafeInteger(account.cashAvailableMinor)).toBe(true);
      expect(account.cashAvailableMinor).toBeGreaterThanOrEqual(0);
      expect(account.cashFrozenMinor).toBeGreaterThanOrEqual(0);
    }
  });

  it("bounds system history through hundreds of ticks while preserving real-user history", () => {
    const h = createLiquidityHarness();
    h.addUser("real-trader", 100_000_000, 0);
    h.liquidity.initializeAccounts();
    h.liquidity.refreshAll();
    h.market.setBestPrices();
    const bestAsk = h.market
      .snapshots()
      .find((quote) => quote.symbol === "AAPL")!.bestAskMinor!;
    const filled = h.service.place(
      "real-trader",
      request("BUY", bestAsk, 100, "real-filled-history")
    ).order;
    const canceled = h.service.place(
      "real-trader",
      request("BUY", 1, 1, "real-canceled-history")
    ).order;
    h.service.cancel("real-trader", canceled.id);
    const tradesBefore = structuredClone(h.state.trades);

    for (let tick = 0; tick < 200; tick += 1) h.cycle.tick();

    const systemOrders = [...h.state.orders.values()].filter((order) =>
      [SYSTEM_MARKET_BUYER_ID, SYSTEM_MARKET_SELLER_ID].includes(order.userId)
    );
    const activeSystemOrders = h.service.listSystemOrders();
    const realOrders = h.service.listForUser("real-trader");
    expect(activeSystemOrders).toHaveLength(18);
    expect(systemOrders).toHaveLength(18);
    expect(
      systemOrders.filter(
        (order) => order.status === "FILLED" || order.status === "CANCELED"
      )
    ).toHaveLength(0);
    expect(h.state.orders).toHaveLength(20);
    expect(h.state.idempotency).toHaveLength(20);
    expect(realOrders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: filled.id, status: "FILLED" }),
        expect.objectContaining({ id: canceled.id, status: "CANCELED" })
      ])
    );
    expect(
      [...h.state.idempotency.keys()]
        .filter((key) => key.startsWith("real-trader:"))
        .sort()
    ).toEqual([
      "real-trader:real-canceled-history",
      "real-trader:real-filled-history"
    ]);
    expect(h.state.trades).toEqual(tradesBefore);
    expect(h.service.recentTradesForUser("real-trader")).toEqual(
      [...tradesBefore].reverse()
    );
    for (const quote of h.market.snapshots()) {
      expect(quote.history).toHaveLength(60);
      expect(quote.bestBidMinor).not.toBeNull();
      expect(quote.bestAskMinor).not.toBeNull();
    }
  }, 60_000);
});
