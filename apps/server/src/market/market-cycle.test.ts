import { describe, expect, it } from "vitest";

import { AccountLedger } from "../accounts/account-ledger.js";
import {
  type Clock,
  EventJournal,
  type IdGenerator,
  type JournalEvent
} from "../infrastructure/event-journal.js";
import { MemoryState } from "../infrastructure/memory-state.js";
import { LiquidityService } from "../liquidity/liquidity-service.js";
import { OrderService } from "../orders/order-service.js";
import { type IntervalScheduler, MarketCycle } from "./market-cycle.js";
import { MarketSimulator, type RandomSource } from "./market-simulator.js";

const instant = "2026-08-29T00:00:00.000Z";

const createMarketCycleHarness = (random: RandomSource) => {
  const state = new MemoryState();
  const ledger = new AccountLedger(state);
  const clock: Clock = { now: () => instant };
  let nextId = 0;
  const ids: IdGenerator = { next: () => `id-${++nextId}` };
  const journal = new EventJournal(clock, ids);
  const events: JournalEvent[] = [];
  journal.subscribe((event) => events.push(event));
  const orders = new OrderService(state, ledger, journal, clock, ids);
  const market = new MarketSimulator(state, journal, clock, random);
  market.initialize();
  const liquidity = new LiquidityService(state, ledger, orders, market);
  liquidity.initializeAccounts();
  return { state, journal, events, market, liquidity };
};

const createScheduler = () => {
  const callbacks: Array<() => void> = [];
  const cleared: unknown[] = [];
  const delays: number[] = [];
  let nextHandle = 0;
  const scheduler: IntervalScheduler = {
    setInterval: (callback, delayMs) => {
      callbacks.push(callback);
      delays.push(delayMs);
      return `timer-${++nextHandle}`;
    },
    clearInterval: (handle) => {
      cleared.push(handle);
    }
  };
  return { scheduler, callbacks, cleared, delays };
};

describe("MarketCycle", () => {
  it("publishes committed quotes after movement and liquidity refresh", () => {
    const h = createMarketCycleHarness({ next: () => 1 });
    const cycle = new MarketCycle(h.market, h.liquidity);

    cycle.tick();

    const marketEvents = h.events.filter(
      (event) => event.type === "market.updated"
    );
    expect(marketEvents).toHaveLength(3);
    expect(marketEvents[0]).toMatchObject({
      audience: { kind: "public" },
      payload: {
        symbol: "AAPL",
        lastPriceMinor: 18_793,
        bestBidMinor: 18_774,
        bestAskMinor: 18_812
      }
    });
  });

  it("owns at most one restartable one-second interval", () => {
    const h = createMarketCycleHarness({ next: () => 0.5 });
    const timers = createScheduler();
    const cycle = new MarketCycle(
      h.market,
      h.liquidity,
      timers.scheduler,
      () => undefined
    );

    cycle.start();
    cycle.start();
    cycle.stop();
    cycle.stop();
    cycle.start();
    cycle.stop();

    expect(timers.delays).toEqual([1_000, 1_000]);
    expect(timers.cleared).toEqual(["timer-1", "timer-2"]);
  });

  it("reports one failed interval tick and continues on the next interval", () => {
    let randomCalls = 0;
    const h = createMarketCycleHarness({
      next: () => {
        randomCalls += 1;
        if (randomCalls === 1) throw new Error("random unavailable");
        return 0.5;
      }
    });
    const timers = createScheduler();
    const errors: unknown[] = [];
    const cycle = new MarketCycle(
      h.market,
      h.liquidity,
      timers.scheduler,
      (error) => errors.push(error)
    );
    cycle.start();

    timers.callbacks[0]!();
    timers.callbacks[0]!();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(new Error("random unavailable"));
    expect(
      h.events.filter((event) => event.type === "market.updated")
    ).toHaveLength(3);
    expect(timers.cleared).toEqual([]);
  });
});
