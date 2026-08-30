import type { Order } from "@paper/shared";
import { describe, expect, it } from "vitest";

import {
  type Clock,
  EventJournal,
  type IdGenerator,
  type JournalEvent
} from "../infrastructure/event-journal.js";
import { MemoryState } from "../infrastructure/memory-state.js";
import { OrderBook } from "../matching/order-book.js";
import { MarketSimulator, type RandomSource } from "./market-simulator.js";

const instant = "2026-08-29T00:00:00.000Z";

const createMarketWithSources = (random: RandomSource, clock: Clock) => {
  const state = new MemoryState();
  let idIndex = 0;
  const ids: IdGenerator = { next: () => `event-${++idIndex}` };
  const journal = new EventJournal(clock, ids);
  const events: JournalEvent[] = [];
  journal.subscribe((event) => events.push(event));
  const market = new MarketSimulator(state, journal, clock, random);
  return { state, market, events };
};

const createMarket = (randomValues: readonly number[]) => {
  let randomIndex = 0;
  const random: RandomSource = {
    next: () => randomValues[randomIndex++] ?? randomValues.at(-1) ?? 0.5
  };
  let clockIndex = 0;
  const clock: Clock = {
    now: () => `2026-08-29T00:00:${String(clockIndex++).padStart(2, "0")}.000Z`
  };
  return createMarketWithSources(random, clock);
};

const order = (
  id: string,
  side: Order["side"],
  limitPriceMinor: number,
  sequence: number
): Order => ({
  id,
  clientOrderId: `client-${id}`,
  userId: `user-${id}`,
  symbol: "AAPL",
  side,
  limitPriceMinor,
  originalQuantity: 1,
  remainingQuantity: 1,
  status: "OPEN",
  sequence,
  createdAt: instant,
  updatedAt: instant
});

describe("MarketSimulator", () => {
  it("maps injected movement from -0.5% through +0.5%", () => {
    const h = createMarket([0, 0.5, 1]);
    h.market.initialize();

    h.market.advanceAll();

    expect(
      h.market
        .snapshots()
        .map((quote) => [
          quote.symbol,
          quote.openPriceMinor,
          quote.lastPriceMinor
        ])
    ).toEqual([
      ["AAPL", 18_700, 18_607],
      ["MSFT", 42_600, 42_600],
      ["TSLA", 24_400, 24_522]
    ]);
  });

  it("uses injected movement and retains only the newest 60 points", () => {
    const h = createMarket(Array(61 * 3).fill(1));
    h.market.initialize();
    for (let index = 0; index < 61; index += 1) h.market.advanceAll();

    const aapl = h.market.snapshots().find((quote) => quote.symbol === "AAPL");

    expect(aapl?.history).toHaveLength(60);
    expect(aapl?.lastPriceMinor).toBeGreaterThan(18_700);
    expect(aapl?.history.at(-1)?.priceMinor).toBe(aapl?.lastPriceMinor);
    expect(aapl?.changePercent).toBeCloseTo(
      ((aapl!.lastPriceMinor - 18_700) / 18_700) * 100
    );
  });

  it("keeps every quote unchanged when the second random read throws", () => {
    let randomCalls = 0;
    const h = createMarketWithSources(
      {
        next: () => {
          randomCalls += 1;
          if (randomCalls === 2) throw new Error("second random failed");
          return 1;
        }
      },
      { now: () => instant }
    );
    h.market.initialize();
    const before = h.market.snapshots();

    expect(() => h.market.advanceAll()).toThrow("second random failed");

    expect(h.market.snapshots()).toEqual(before);
  });

  it("keeps every quote unchanged when the third advance clock read throws", () => {
    let clockCalls = 0;
    const h = createMarketWithSources(
      { next: () => 1 },
      {
        now: () => {
          clockCalls += 1;
          if (clockCalls === 6) throw new Error("third clock failed");
          return instant;
        }
      }
    );
    h.market.initialize();
    const before = h.market.snapshots();

    expect(() => h.market.advanceAll()).toThrow("third clock failed");

    expect(h.market.snapshots()).toEqual(before);
  });

  it("rejects an invalid third movement without committing any quote", () => {
    let randomCalls = 0;
    const h = createMarketWithSources(
      {
        next: () => {
          randomCalls += 1;
          return randomCalls === 3 ? Number.NaN : 0.5;
        }
      },
      { now: () => instant }
    );
    h.market.initialize();
    const before = h.market.snapshots();

    expect(() => h.market.advanceAll()).toThrow();

    expect(h.market.snapshots()).toEqual(before);
  });

  it("derives the best prices from each current order book", () => {
    const h = createMarket([0.5]);
    h.market.initialize();
    const book = new OrderBook("AAPL");
    book.submit(order("buy-low", "BUY", 18_600, 1));
    book.submit(order("buy-high", "BUY", 18_650, 2));
    book.submit(order("sell-high", "SELL", 18_800, 3));
    book.submit(order("sell-low", "SELL", 18_750, 4));
    h.state.books.set("AAPL", book);

    h.market.setBestPrices();

    expect(h.market.snapshots()[0]).toMatchObject({
      bestBidMinor: 18_650,
      bestAskMinor: 18_750
    });
  });

  it("publishes one public market event per symbol from defensive snapshots", () => {
    const h = createMarket([0.5]);
    h.market.initialize();

    h.market.publishAll();
    const marketEvents = h.events.filter(
      (event) => event.type === "market.updated"
    );
    if (marketEvents[0]?.type === "market.updated") {
      marketEvents[0].payload.lastPriceMinor = 1;
    }

    expect(marketEvents).toHaveLength(3);
    expect(
      marketEvents.every((event) => event.audience.kind === "public")
    ).toBe(true);
    expect(h.market.snapshots()[0]?.lastPriceMinor).toBe(18_700);
  });
});
