import type { PlaceOrderRequest } from "@paper/shared";
import { describe, expect, it } from "vitest";

import { AccountLedger } from "../accounts/account-ledger.js";
import { DomainError } from "../infrastructure/domain-error.js";
import {
  EventJournal,
  type Clock,
  type EventDraft,
  type IdGenerator,
  type JournalEvent
} from "../infrastructure/event-journal.js";
import {
  MemoryState,
  type UserRecord
} from "../infrastructure/memory-state.js";
import { OrderService } from "./order-service.js";

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

const orderEventDraft = (id: string): EventDraft => ({
  type: "order.updated",
  audience: { kind: "user", userId: "buyer" },
  payload: {
    id,
    clientOrderId: `client-${id}`,
    userId: "buyer",
    symbol: "AAPL",
    side: "BUY",
    limitPriceMinor: 100,
    originalQuantity: 1,
    remainingQuantity: 1,
    status: "OPEN",
    sequence: 1,
    createdAt: instant,
    updatedAt: instant
  }
});

const createOrderHarness = () => {
  const state = new MemoryState();
  const ledger = new AccountLedger(state);
  const clock: Clock = { now: () => instant };
  let nextId = 0;
  const ids: IdGenerator = { next: () => `id-${++nextId}` };
  const journal = new EventJournal(clock, ids);
  const events: JournalEvent[] = [];
  journal.subscribe((event) => events.push(event));
  const service = new OrderService(state, ledger, journal, clock, ids);

  const addReal = (id: string): void => {
    state.users.set(id, user(id, "REAL"));
    ledger.createRealAccount(id);
  };
  const addSystem = (
    id: string,
    cashMinor: number,
    positions: Parameters<AccountLedger["seedSystemAccount"]>[2]
  ): void => {
    state.users.set(id, user(id, "SYSTEM"));
    ledger.seedSystemAccount(id, cashMinor, positions);
  };

  return { state, ledger, journal, events, service, addReal, addSystem };
};

describe("OrderService", () => {
  it("settles both users and emits distinct versions from committed state", () => {
    const h = createOrderHarness();
    h.addReal("buyer");
    h.addSystem("seller", 0, { AAPL: 100 });
    h.service.place("seller", request("SELL", 18_700, 100, "sell-request"));
    const commandEventStart = h.events.length;
    const result = h.service.place(
      "buyer",
      request("BUY", 18_700, 100, "buy-request")
    );
    const commandEvents = h.events.slice(commandEventStart);

    expect(result.order.status).toBe("FILLED");
    expect(result.trades).toHaveLength(1);
    expect(h.ledger.snapshot("buyer")).toMatchObject({
      cashAvailableMinor: 98_130_000,
      cashFrozenMinor: 0,
      positions: { AAPL: { availableQuantity: 100, frozenQuantity: 0 } }
    });
    expect(h.ledger.snapshot("seller")).toMatchObject({
      cashAvailableMinor: 1_870_000,
      positions: { AAPL: { availableQuantity: 0, frozenQuantity: 0 } }
    });
    expect(h.events.map((event) => event.stateVersion)).toEqual(
      h.events.map((_event, index) => index + 1)
    );
    expect(
      commandEvents.every((event) => {
        if (event.type === "order.updated") {
          return h.service
            .listForUser(event.payload.userId)
            .some(
              (order) =>
                order.id === event.payload.id &&
                order.status === event.payload.status
            );
        }
        return true;
      })
    ).toBe(true);
  });

  it("returns the existing order for a repeated clientOrderId without side effects", () => {
    const h = createOrderHarness();
    h.addReal("buyer");
    const first = h.service.place(
      "buyer",
      request("BUY", 18_000, 10, "same-id")
    );
    const eventCount = h.events.length;
    const frozenCash = h.ledger.snapshot("buyer").cashFrozenMinor;

    const second = h.service.place(
      "buyer",
      request("BUY", 19_000, 20, "same-id")
    );

    expect(second.order.id).toBe(first.order.id);
    expect(second.replayed).toBe(true);
    expect(h.service.listForUser("buyer")).toHaveLength(1);
    expect(h.ledger.snapshot("buyer").cashFrozenMinor).toBe(frozenCash);
    expect(h.events).toHaveLength(eventCount);
  });

  it("replays a filled command's exact trade snapshot defensively", () => {
    const h = createOrderHarness();
    h.addReal("buyer");
    h.addSystem("seller", 0, { AAPL: 1 });
    h.service.place("seller", request("SELL", 90, 1, "single-sell"));
    const first = h.service.place(
      "buyer",
      request("BUY", 100, 1, "single-buy")
    );
    const eventCount = h.events.length;

    const replay = h.service.place(
      "buyer",
      request("BUY", 1, 99, "single-buy")
    );
    replay.trades[0]!.quantity = 99;

    const replayAgain = h.service.place(
      "buyer",
      request("BUY", 1, 99, "single-buy")
    );
    expect(replay.order).toEqual(first.order);
    expect(replayAgain.trades).toEqual(first.trades);
    expect(replayAgain.replayed).toBe(true);
    expect(h.events).toHaveLength(eventCount);
  });

  it("replays every fill from a multi-fill command", () => {
    const h = createOrderHarness();
    h.addReal("buyer");
    h.addSystem("seller", 0, { AAPL: 5 });
    h.addSystem("seller-two", 0, { AAPL: 6 });
    h.service.place("seller", request("SELL", 90, 5, "first-fill"));
    h.service.place("seller-two", request("SELL", 95, 6, "second-fill"));
    const first = h.service.place(
      "buyer",
      request("BUY", 100, 11, "multi-buy")
    );

    const replay = h.service.place("buyer", request("BUY", 1, 1, "multi-buy"));

    expect(first.trades).toHaveLength(2);
    expect(replay.trades).toEqual(first.trades);
    expect(replay.replayed).toBe(true);
  });

  it("releases an unfilled buy reservation on cancel", () => {
    const h = createOrderHarness();
    h.addReal("buyer");
    const placed = h.service.place(
      "buyer",
      request("BUY", 18_000, 10, "cancel-id")
    );

    const canceled = h.service.cancel("buyer", placed.order.id);

    expect(canceled.order.status).toBe("CANCELED");
    expect(h.ledger.snapshot("buyer").cashFrozenMinor).toBe(0);
    expect(h.ledger.snapshot("buyer").cashAvailableMinor).toBe(100_000_000);
  });

  it("rejects repeated cancel without changing the canceled order or account", () => {
    const h = createOrderHarness();
    h.addReal("buyer");
    const placed = h.service.place(
      "buyer",
      request("BUY", 18_000, 10, "repeat-cancel")
    );
    const first = h.service.cancel("buyer", placed.order.id);
    const accountBefore = h.ledger.snapshot("buyer");
    const eventCount = h.events.length;

    expect(() => h.service.cancel("buyer", placed.order.id)).toThrowError(
      new DomainError("ORDER_NOT_ACTIVE", 409, "订单不可撤销")
    );
    expect(h.service.listForUser("buyer")).toContainEqual(first.order);
    expect(h.ledger.snapshot("buyer")).toEqual(accountBefore);
    expect(h.events).toHaveLength(eventCount);
  });

  it("rejects cancel for a filled order without changing settled state", () => {
    const h = createOrderHarness();
    h.addReal("buyer");
    h.addSystem("seller", 0, { AAPL: 1 });
    h.service.place("seller", request("SELL", 90, 1, "filled-sell"));
    const filled = h.service.place(
      "buyer",
      request("BUY", 100, 1, "filled-buy")
    ).order;
    const accountBefore = h.ledger.snapshot("buyer");
    const eventCount = h.events.length;

    expect(() => h.service.cancel("buyer", filled.id)).toThrowError(
      new DomainError("ORDER_NOT_ACTIVE", 409, "订单不可撤销")
    );
    expect(h.service.listForUser("buyer")).toContainEqual(filled);
    expect(h.ledger.snapshot("buyer")).toEqual(accountBefore);
    expect(h.events).toHaveLength(eventCount);
  });

  it("releases only the remaining reservation when canceling a partially filled order", () => {
    const h = createOrderHarness();
    h.addReal("buyer");
    h.addSystem("seller", 0, { AAPL: 4 });
    h.service.place("seller", request("SELL", 90, 4, "partial-sell"));
    const placed = h.service.place(
      "buyer",
      request("BUY", 100, 10, "partial-buy")
    );

    h.service.cancel("buyer", placed.order.id);

    expect(h.ledger.snapshot("buyer")).toMatchObject({
      cashAvailableMinor: 99_999_640,
      cashFrozenMinor: 0,
      positions: { AAPL: { availableQuantity: 4, frozenQuantity: 0 } }
    });
  });

  it("does not allow another user to cancel an order", () => {
    const h = createOrderHarness();
    h.addReal("owner");
    h.addReal("intruder");
    const placed = h.service.place("owner", request("BUY", 100, 10, "owned"));

    expect(() => h.service.cancel("intruder", placed.order.id)).toThrowError(
      new DomainError("ORDER_NOT_FOUND", 404, "订单不存在")
    );
    expect(h.service.listForUser("owner")[0]).toMatchObject({ status: "OPEN" });
    expect(h.ledger.snapshot("owner").cashFrozenMinor).toBe(1_000);
  });

  it("releases an incoming real user's remainder when self-trade prevention fires", () => {
    const h = createOrderHarness();
    h.addReal("same");
    h.ledger.seedSystemAccount("inventory", 0, { AAPL: 10 });
    h.state.users.set("inventory", user("inventory", "SYSTEM"));
    h.service.place("inventory", request("SELL", 90, 4, "first-sell"));
    h.service.place("same", request("BUY", 90, 4, "first-buy"));
    h.ledger.seedSystemAccount("same-seller", 0, { AAPL: 10 });
    h.state.users.set("same-seller", user("same-seller", "SYSTEM"));
    h.service.place("same-seller", request("SELL", 95, 6, "seed-same"));
    const acquired = h.service.place("same", request("BUY", 95, 6, "acquire"));
    expect(acquired.order.status).toBe("FILLED");
    h.service.place("same", request("SELL", 100, 6, "self-sell"));

    const result = h.service.place("same", request("BUY", 100, 10, "self-buy"));

    expect(result.order).toMatchObject({
      status: "CANCELED",
      remainingQuantity: 10
    });
    expect(h.ledger.snapshot("same").cashFrozenMinor).toBe(0);
  });

  it("derives the self-trade predicate from memory-state user kind", () => {
    const h = createOrderHarness();
    h.addSystem("market-maker", 1_000, { AAPL: 1 });
    h.service.place("market-maker", request("SELL", 100, 1, "system-sell"));

    const result = h.service.place(
      "market-maker",
      request("BUY", 100, 1, "system-buy")
    );

    expect(result.order.status).toBe("FILLED");
    expect(result.trades).toHaveLength(1);
    expect(h.ledger.snapshot("market-maker")).toMatchObject({
      cashAvailableMinor: 1_000,
      cashFrozenMinor: 0,
      positions: { AAPL: { availableQuantity: 1, frozenQuantity: 0 } }
    });
  });

  it("retains only the newest 1000 global trades and newest 50 user trades", () => {
    const h = createOrderHarness();
    h.addReal("buyer");
    h.addSystem("seller", 0, { AAPL: 1_005 });

    let firstFilledCommand: ReturnType<OrderService["place"]> | undefined;
    for (let index = 0; index < 1_005; index += 1) {
      h.service.place("seller", request("SELL", 1, 1, `sell-${index}`));
      const placed = h.service.place(
        "buyer",
        request("BUY", 1, 1, `buy-${index}`)
      );
      if (index === 0) firstFilledCommand = placed;
    }

    const replay = h.service.place("buyer", request("BUY", 2, 2, "buy-0"));

    expect(h.state.trades).toHaveLength(1_000);
    expect(h.state.trades[0]?.sequence).toBe(6);
    expect(replay.trades).toEqual(firstFilledCommand!.trades);
    expect(replay.replayed).toBe(true);
    expect(h.service.recentTradesForUser("buyer")).toHaveLength(50);
    expect(h.service.recentTradesForUser("buyer")[0]?.sequence).toBe(1_005);
  }, 20_000);

  it("lists only active system orders for a symbol with defensive snapshots", () => {
    const h = createOrderHarness();
    h.addSystem("system-buyer", 1_000, {});
    h.addSystem("system-seller", 0, { MSFT: 1 });
    h.addReal("real-buyer");
    h.service.place("system-buyer", request("BUY", 10, 1, "system-aapl"));
    h.service.place("real-buyer", request("BUY", 9, 1, "real-aapl"));
    h.service.place(
      "system-seller",
      request("SELL", 20, 1, "system-msft", "MSFT")
    );

    const listed = h.service.listSystemOrders("AAPL");
    listed[0]!.status = "FILLED";

    expect(listed).toHaveLength(1);
    expect(listed[0]?.userId).toBe("system-buyer");
    expect(h.service.listSystemOrders("AAPL")[0]?.status).toBe("OPEN");
  });

  it("returns defensive order snapshots", () => {
    const h = createOrderHarness();
    h.addReal("buyer");
    const placed = h.service.place("buyer", request("BUY", 100, 1, "snapshot"));
    placed.order.status = "FILLED";

    expect(h.service.listForUser("buyer")[0]).toMatchObject({ status: "OPEN" });
    expect(h.journal.currentVersion).toBe(2);
  });

  it("does not leave a reservation or order when reservation fails", () => {
    const h = createOrderHarness();
    h.addReal("buyer");

    expect(() =>
      h.service.place("buyer", request("BUY", 100_000_000, 2, "too-large"))
    ).toThrowError(new DomainError("INSUFFICIENT_FUNDS", 409, "可用资金不足"));
    expect(h.ledger.snapshot("buyer").cashFrozenMinor).toBe(0);
    expect(h.service.listForUser("buyer")).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it("rolls back the reservation when order identity creation throws", () => {
    const state = new MemoryState();
    const ledger = new AccountLedger(state);
    const clock: Clock = { now: () => instant };
    const ids: IdGenerator = {
      next: () => {
        throw new Error("id source unavailable");
      }
    };
    const journal = new EventJournal(clock, ids);
    const service = new OrderService(state, ledger, journal, clock, ids);
    state.users.set("buyer", user("buyer", "REAL"));
    ledger.createRealAccount("buyer");

    expect(() =>
      service.place("buyer", request("BUY", 100, 1, "id-failure"))
    ).toThrowError("id source unavailable");
    expect(ledger.snapshot("buyer")).toMatchObject({
      cashAvailableMinor: 100_000_000,
      cashFrozenMinor: 0
    });
    expect(service.listForUser("buyer")).toEqual([]);
  });

  it("restores existing idempotency records when event creation throws", () => {
    const state = new MemoryState();
    const ledger = new AccountLedger(state);
    const clock: Clock = { now: () => instant };
    let nextId = 0;
    let callsUntilFailure: number | undefined;
    const ids: IdGenerator = {
      next: () => {
        if (callsUntilFailure === 0) {
          callsUntilFailure = undefined;
          throw new Error("event identity unavailable");
        }
        if (callsUntilFailure !== undefined) callsUntilFailure -= 1;
        return `id-${++nextId}`;
      }
    };
    const journal = new EventJournal(clock, ids);
    const service = new OrderService(state, ledger, journal, clock, ids);
    state.users.set("buyer", user("buyer", "REAL"));
    ledger.createRealAccount("buyer");
    const first = service.place("buyer", request("BUY", 100, 1, "first"));
    callsUntilFailure = 1;

    expect(() =>
      service.place("buyer", request("BUY", 100, 1, "fails-late"))
    ).toThrowError("event identity unavailable");

    expect([...state.idempotency.keys()]).toEqual(["buyer:first"]);
    expect(service.place("buyer", request("BUY", 1, 9, "first"))).toEqual({
      ...first,
      replayed: true
    });
    expect(service.listForUser("buyer")).toHaveLength(1);
    expect(ledger.snapshot("buyer").cashFrozenMinor).toBe(100);
  });

  it("rolls back matching and reservation when settlement cannot commit", () => {
    const h = createOrderHarness();
    h.addReal("buyer");
    h.addSystem("seller", Number.MAX_SAFE_INTEGER, { AAPL: 1 });
    const resting = h.service.place(
      "seller",
      request("SELL", 1, 1, "overflow-sell")
    );
    const eventCount = h.events.length;

    expect(() =>
      h.service.place("buyer", request("BUY", 1, 1, "overflow-buy"))
    ).toThrowError(
      new DomainError("INVARIANT_VIOLATION", 500, "账户状态不合法")
    );
    expect(h.ledger.snapshot("buyer")).toMatchObject({
      cashAvailableMinor: 100_000_000,
      cashFrozenMinor: 0
    });
    expect(h.service.listForUser("buyer")).toEqual([]);
    expect(h.service.listForUser("seller")[0]).toMatchObject({
      id: resting.order.id,
      status: "OPEN",
      remainingQuantity: 1
    });
    expect(h.ledger.snapshot("seller").positions.AAPL.frozenQuantity).toBe(1);
    expect(h.events).toHaveLength(eventCount);
  });
});

describe("EventJournal", () => {
  it("delivers nested publications in strictly increasing version order", () => {
    const clock: Clock = { now: () => instant };
    let nextId = 0;
    const ids: IdGenerator = { next: () => `event-${++nextId}` };
    const journal = new EventJournal(clock, ids);
    const observedVersions: number[] = [];
    let nestedPublished: JournalEvent[] = [];
    journal.subscribe((event) => {
      if (event.stateVersion === 1) {
        nestedPublished = journal.publish([orderEventDraft("nested")]);
      }
    });
    journal.subscribe((event) => observedVersions.push(event.stateVersion));

    const outerPublished = journal.publish([
      orderEventDraft("outer-one"),
      orderEventDraft("outer-two")
    ]);

    expect(observedVersions).toEqual([1, 2, 3]);
    expect(outerPublished.map((event) => event.stateVersion)).toEqual([1, 2]);
    expect(nestedPublished.map((event) => event.stateVersion)).toEqual([3]);
    expect(journal.currentVersion).toBe(3);
  });

  it("continues delivery when a subscriber throws", () => {
    const clock: Clock = { now: () => instant };
    const ids: IdGenerator = { next: () => "event" };
    const journal = new EventJournal(clock, ids);
    const observedVersions: number[] = [];
    journal.subscribe(() => {
      throw new Error("transport unavailable");
    });
    journal.subscribe((event) => observedVersions.push(event.stateVersion));

    const published = journal.publish([orderEventDraft("survives")]);

    expect(observedVersions).toEqual([1]);
    expect(published[0]?.stateVersion).toBe(1);
    expect(journal.currentVersion).toBe(1);
  });

  it("isolates subscribers and returned events with defensive snapshots", () => {
    const clock: Clock = { now: () => instant };
    let nextId = 0;
    const ids: IdGenerator = { next: () => `event-${++nextId}` };
    const journal = new EventJournal(clock, ids);
    const observed: JournalEvent[] = [];
    journal.subscribe((event) => {
      event.audience = { kind: "public" };
      if (event.type === "order.updated") event.payload.status = "FILLED";
    });
    journal.subscribe((event) => observed.push(event));

    const published = journal.publish([
      {
        type: "order.updated",
        audience: { kind: "user", userId: "buyer" },
        payload: {
          id: "order",
          clientOrderId: "client",
          userId: "buyer",
          symbol: "AAPL",
          side: "BUY",
          limitPriceMinor: 100,
          originalQuantity: 1,
          remainingQuantity: 1,
          status: "OPEN",
          sequence: 1,
          createdAt: instant,
          updatedAt: instant
        }
      }
    ]);
    published[0]!.audience = { kind: "public" };

    expect(observed[0]).toMatchObject({
      audience: { kind: "user", userId: "buyer" },
      payload: { status: "OPEN" },
      eventId: "event-1",
      stateVersion: 1
    });
  });
});
