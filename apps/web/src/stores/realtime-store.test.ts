import type {
  BootstrapResponse,
  BusinessServerEvent,
  ServerEvent,
  Trade
} from "@paper/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClientError } from "../api/http-client.js";
import { RealtimeClient, type RealtimeSocket } from "../api/realtime-client.js";
import type {
  RealtimeClientCallbacks,
  RealtimeTransport
} from "./realtime-store.js";
import { createRealtimeStoreHarness } from "./realtime-store.js";
import { createTradingStoreHarness } from "./trading-store.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const settlementWithinTurn = async (
  promise: Promise<void>
): Promise<"resolved" | "rejected" | "pending"> =>
  Promise.race([
    promise.then(
      () => "resolved" as const,
      () => "rejected" as const
    ),
    new Promise<"pending">((resolve) =>
      globalThis.setTimeout(() => resolve("pending"), 0)
    )
  ]);

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

const bootstrapFixture = (stateVersion: number): BootstrapResponse => ({
  user: { id: "user-1", username: "trader_01" },
  account: {
    userId: "user-1",
    cashAvailableMinor: stateVersion,
    cashFrozenMinor: 0,
    positions: {
      AAPL: { availableQuantity: 0, frozenQuantity: 0 },
      MSFT: { availableQuantity: 0, frozenQuantity: 0 },
      TSLA: { availableQuantity: 0, frozenQuantity: 0 }
    }
  },
  stocks: [],
  orders: [],
  trades: [],
  stateVersion
});

const tradeEvent = (
  stateVersion: number,
  eventId = `event-${stateVersion}`,
  tradeId = `trade-${stateVersion}`
): BusinessServerEvent => ({
  type: "trade.created",
  eventId,
  stateVersion,
  occurredAt: "2026-08-29T00:00:00.000Z",
  payload: tradeFixture(tradeId, stateVersion)
});

class FakeTransport implements RealtimeTransport {
  connectCalls = 0;
  disconnectCalls = 0;
  retryCalls = 0;
  synchronizedCalls = 0;

  constructor(readonly callbacks: RealtimeClientCallbacks) {}

  connect(): void {
    this.connectCalls += 1;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
  }

  retry(): void {
    this.retryCalls += 1;
  }

  markSynchronized(): void {
    this.synchronizedCalls += 1;
  }

  open(): void {
    this.callbacks.onOpen();
  }

  message(event: ServerEvent): void {
    this.callbacks.onMessage(event);
  }

  close(retryDelayMs: number | null = 500): void {
    this.callbacks.onClose({ event: null, retryDelayMs });
  }

  terminal(code = 1008, reason = "session expired"): void {
    this.callbacks.onTerminalError({
      code,
      reason,
      error: new Error(`terminal websocket close ${code}`)
    });
  }

  protocolError(): void {
    this.callbacks.onProtocolError(new Error("invalid known event"));
  }
}

class ProtocolSocket implements RealtimeSocket {
  readyState: number = WebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  message(value: unknown): void {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(value) })
    );
  }

  close(code = 1000, reason = ""): void {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason, wasClean: true }));
  }
}

const createHarness = (onUnauthorized?: () => void) => {
  const trading = createTradingStoreHarness();
  const bootstraps: Array<ReturnType<typeof deferred<BootstrapResponse>>> = [];
  let transport: FakeTransport | undefined;
  let unauthorizedCalls = 0;
  const store = createRealtimeStoreHarness({
    trading,
    bootstrapClient: {
      bootstrap: () => {
        const request = deferred<BootstrapResponse>();
        bootstraps.push(request);
        return request.promise;
      }
    },
    createTransport: (callbacks) => {
      transport = new FakeTransport(callbacks);
      return transport;
    },
    onUnauthorized: () => {
      unauthorizedCalls += 1;
      onUnauthorized?.();
    }
  });
  return {
    store,
    trading,
    bootstraps,
    get transport(): FakeTransport {
      return transport!;
    },
    unauthorizedCalls: () => unauthorizedCalls
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("realtime store", () => {
  it("buffers, deduplicates, and version-sorts business events during bootstrap", async () => {
    const h = createHarness();
    const connecting = h.store.connect();
    h.transport.open();
    h.transport.message({
      type: "connection.ready",
      stateVersion: 19,
      occurredAt: "2026-08-29T00:00:00.000Z"
    });
    h.transport.message(tradeEvent(22));
    h.transport.message({
      type: "heartbeat",
      occurredAt: "2026-08-29T00:00:01.000Z"
    });
    h.transport.message(tradeEvent(20));
    h.transport.message(tradeEvent(22));
    h.transport.message(tradeEvent(18));

    h.bootstraps[0]!.resolve(bootstrapFixture(19));
    await connecting;

    expect(h.store.connectionStatus).toBe("live");
    expect(h.trading.stateVersion).toBe(22);
    expect(h.trading.trades.map(({ id }) => id)).toEqual([
      "trade-22",
      "trade-20"
    ]);
    expect(h.transport.synchronizedCalls).toBe(1);
  });

  it("keeps one connect operation across concurrent callers and reconnects", async () => {
    const h = createHarness();

    const first = h.store.connect();
    const second = h.store.connect();
    expect(first).toBe(second);
    expect(h.transport.connectCalls).toBe(1);
    expect(h.store.connectionStatus).toBe("connecting");

    h.transport.open();
    h.bootstraps[0]!.resolve(bootstrapFixture(10));
    await first;
    h.transport.close(500);
    expect(h.store.connectionStatus).toBe("reconnecting");
    let recoveryResolved = false;
    const recovery = h.store.connect().then(() => {
      recoveryResolved = true;
    });
    await Promise.resolve();
    expect(recoveryResolved).toBe(false);
    h.transport.close(1_000);
    h.transport.open();
    h.bootstraps[1]!.resolve(bootstrapFixture(11));
    await recovery;

    expect(h.store.connectionStatus).toBe("live");
    expect(h.trading.stateVersion).toBe(11);
    expect(h.transport.connectCalls).toBe(1);
  });

  it("ignores stale bootstrap completion from an older socket generation", async () => {
    const h = createHarness();
    const connecting = h.store.connect();
    h.transport.open();
    const stale = h.bootstraps[0]!;
    h.transport.close();
    h.transport.open();
    const current = h.bootstraps[1]!;

    current.resolve(bootstrapFixture(10));
    await connecting;
    stale.resolve(bootstrapFixture(99));
    await Promise.resolve();

    expect(h.trading.stateVersion).toBe(10);
    expect(h.store.connectionStatus).toBe("live");
  });

  it("retries a failed bootstrap without applying its buffered events", async () => {
    const h = createHarness();
    const connecting = h.store.connect();
    h.transport.open();
    h.transport.message(tradeEvent(3));
    h.bootstraps[0]!.reject(new ApiClientError(0, "NETWORK_ERROR", "offline"));

    await expect(connecting).rejects.toMatchObject({ code: "NETWORK_ERROR" });

    expect(h.transport.retryCalls).toBe(1);
    expect(h.store.connectionStatus).toBe("reconnecting");
    expect(h.trading.trades).toEqual([]);

    const recovered = h.store.connect();
    h.transport.open();
    h.bootstraps[1]!.resolve(bootstrapFixture(4));
    await recovered;
    expect(h.trading.stateVersion).toBe(4);
  });

  it("goes offline and stops retries when bootstrap returns 401", async () => {
    const h = createHarness();
    let registeredCalls = 0;
    const removeHandler = h.store.onUnauthorized(() => {
      registeredCalls += 1;
    });
    const connecting = h.store.connect();
    h.transport.open();
    h.bootstraps[0]!.reject(new ApiClientError(401, "UNAUTHORIZED", "login"));

    await expect(connecting).rejects.toMatchObject({ status: 401 });
    expect(h.store.connectionStatus).toBe("offline");
    expect(h.transport.disconnectCalls).toBe(1);
    expect(h.transport.retryCalls).toBe(0);
    expect(h.unauthorizedCalls()).toBe(1);
    expect(registeredCalls).toBe(1);

    removeHandler();
    const second = h.store.connect();
    h.transport.open();
    h.bootstraps[1]!.reject(new ApiClientError(401, "UNAUTHORIZED", "login"));
    await expect(second).rejects.toMatchObject({ status: 401 });
    expect(registeredCalls).toBe(1);
  });

  it.each(["connecting", "live"] as const)(
    "notifies unauthorized once when a %s socket receives server 1008",
    async (phase) => {
      const h = createHarness();
      let registeredCalls = 0;
      h.store.onUnauthorized(() => {
        registeredCalls += 1;
      });
      const connecting = h.store.connect();
      if (phase === "live") {
        h.transport.open();
        h.bootstraps[0]!.resolve(bootstrapFixture(10));
        await connecting;
      }

      h.transport.terminal(1008, "invalid session");
      if (phase === "connecting")
        await expect(connecting).rejects.toThrow(
          "terminal websocket close 1008"
        );

      expect(registeredCalls).toBe(1);
      expect(h.unauthorizedCalls()).toBe(1);
      expect(h.store.connectionStatus).toBe("offline");
      expect(h.transport.retryCalls).toBe(0);
    }
  );

  it("isolates every unauthorized callback before notifying later handlers", async () => {
    const h = createHarness(() => {
      throw new Error("optional callback failed");
    });
    let laterCalls = 0;
    h.store.onUnauthorized(() => {
      throw new Error("registered callback failed");
    });
    h.store.onUnauthorized(() => {
      laterCalls += 1;
    });
    const connecting = h.store.connect();

    expect(() => h.transport.terminal(1008, "invalid session")).not.toThrow();
    await expect(connecting).rejects.toThrow("terminal websocket close 1008");
    expect(h.unauthorizedCalls()).toBe(1);
    expect(laterCalls).toBe(1);
  });

  it("does not invalidate auth for network close or a non-policy terminal close", async () => {
    const h = createHarness();
    let registeredCalls = 0;
    h.store.onUnauthorized(() => {
      registeredCalls += 1;
    });
    const connecting = h.store.connect();
    h.transport.open();
    h.bootstraps[0]!.resolve(bootstrapFixture(10));
    await connecting;

    h.transport.close(500);
    expect(h.store.connectionStatus).toBe("reconnecting");
    expect(registeredCalls).toBe(0);
    expect(h.unauthorizedCalls()).toBe(0);

    h.transport.terminal(4001, "other terminal error");
    expect(h.store.connectionStatus).toBe("offline");
    expect(registeredCalls).toBe(0);
    expect(h.unauthorizedCalls()).toBe(0);
  });

  it("rejects an inconsistent ready version and same-version event conflict", async () => {
    const h = createHarness();
    void h.store.connect();
    h.transport.open();
    h.transport.message({
      type: "connection.ready",
      stateVersion: 10,
      occurredAt: "2026-08-29T00:00:00.000Z"
    });
    h.bootstraps[0]!.resolve(bootstrapFixture(9));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.transport.retryCalls).toBe(1);

    h.transport.open();
    h.transport.message(tradeEvent(12, "event-a", "trade-a"));
    h.transport.message(tradeEvent(12, "event-b", "trade-b"));
    h.bootstraps[1]!.resolve(bootstrapFixture(11));
    await Promise.resolve();
    await Promise.resolve();

    expect(h.transport.retryCalls).toBe(2);
    expect(h.trading.stateVersion).toBe(0);
    h.store.disconnect();
  });

  it("detects a live same-version conflict but applies newer live events", async () => {
    const h = createHarness();
    const connecting = h.store.connect();
    h.transport.open();
    h.bootstraps[0]!.resolve(bootstrapFixture(10));
    await connecting;

    h.transport.message(tradeEvent(11, "event-11", "trade-11"));
    h.transport.message(tradeEvent(11, "event-conflict", "trade-other"));

    expect(h.trading.trades.map(({ id }) => id)).toEqual(["trade-11"]);
    expect(h.transport.retryCalls).toBe(1);
    expect(h.store.connectionStatus).toBe("reconnecting");
  });

  it("recovers instead of applying a good event after an invalid known event", async () => {
    const h = createHarness();
    const connecting = h.store.connect();
    h.transport.open();
    h.bootstraps[0]!.resolve(bootstrapFixture(12));
    await connecting;

    h.transport.protocolError();
    h.transport.message(tradeEvent(14, "event-14", "trade-14"));

    expect(h.transport.retryCalls).toBe(1);
    expect(h.store.connectionStatus).toBe("reconnecting");
    expect(h.trading.stateVersion).toBe(12);
    expect(h.trading.trades).toEqual([]);

    const recovered = h.store.connect();
    h.transport.open();
    h.bootstraps[1]!.resolve(bootstrapFixture(14));
    await recovered;
    expect(h.store.connectionStatus).toBe("live");
  });

  it("closes version 13 invalid order generation before version 14 can advance state", async () => {
    const trading = createTradingStoreHarness();
    const bootstraps: Array<ReturnType<typeof deferred<BootstrapResponse>>> =
      [];
    const sockets: ProtocolSocket[] = [];
    let scheduledRetry: (() => void) | undefined;
    const store = createRealtimeStoreHarness({
      trading,
      bootstrapClient: {
        bootstrap: () => {
          const request = deferred<BootstrapResponse>();
          bootstraps.push(request);
          return request.promise;
        }
      },
      createTransport: (callbacks) =>
        new RealtimeClient({
          ...callbacks,
          socketFactory: () => {
            const socket = new ProtocolSocket();
            sockets.push(socket);
            return socket;
          },
          location: { protocol: "http:", host: "trade.example.test" },
          jitterRatio: 0,
          timer: {
            setTimeout: (callback) => {
              scheduledRetry = callback;
              return callback;
            },
            clearTimeout: () => {
              scheduledRetry = undefined;
            }
          }
        })
    });
    const connecting = store.connect();
    sockets[0]!.open();
    bootstraps[0]!.resolve(bootstrapFixture(12));
    await connecting;

    sockets[0]!.message({
      type: "order.updated",
      eventId: "event-13",
      stateVersion: 13,
      occurredAt: "2026-08-29T00:00:00.000Z",
      payload: {
        id: "order-13",
        clientOrderId: "client-13",
        userId: "user-1",
        symbol: "AAPL",
        side: "BUY",
        limitPriceMinor: 10_000,
        originalQuantity: 10,
        remainingQuantity: 11,
        status: "OPEN",
        sequence: 13,
        createdAt: "2026-08-29T00:00:00.000Z",
        updatedAt: "2026-08-29T00:00:00.000Z"
      }
    });
    sockets[0]!.message(tradeEvent(14));

    expect(store.connectionStatus).toBe("reconnecting");
    expect(trading.stateVersion).toBe(12);
    expect(trading.trades).toEqual([]);

    const recovered = store.connect();
    scheduledRetry?.();
    sockets[1]!.open();
    bootstraps[1]!.resolve(bootstrapFixture(14));
    await recovered;
    expect(store.connectionStatus).toBe("live");
  });

  it("shows reconnecting after liveness timeout and returns live after bootstrap", async () => {
    vi.useFakeTimers();
    const trading = createTradingStoreHarness();
    const bootstraps: Array<ReturnType<typeof deferred<BootstrapResponse>>> =
      [];
    const sockets: ProtocolSocket[] = [];
    const store = createRealtimeStoreHarness({
      trading,
      bootstrapClient: {
        bootstrap: () => {
          const request = deferred<BootstrapResponse>();
          bootstraps.push(request);
          return request.promise;
        }
      },
      createTransport: (callbacks) =>
        new RealtimeClient({
          ...callbacks,
          socketFactory: () => {
            const socket = new ProtocolSocket();
            sockets.push(socket);
            return socket;
          },
          location: { protocol: "http:", host: "trade.example.test" },
          jitterRatio: 0
        })
    });

    const connecting = store.connect();
    sockets[0]!.open();
    bootstraps[0]!.resolve(bootstrapFixture(12));
    await connecting;
    expect(store.connectionStatus).toBe("live");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.connectionStatus).toBe("reconnecting");

    const recovered = store.connect();
    await vi.advanceTimersByTimeAsync(500);
    sockets[1]!.open();
    bootstraps[1]!.resolve(bootstrapFixture(14));
    await recovered;

    expect(store.connectionStatus).toBe("live");
    expect(trading.stateVersion).toBe(14);
    store.disconnect();
  });

  it("rejects the current connect and retries when a malformed bootstrap makes snapshot reduction throw", async () => {
    const h = createHarness();
    const connecting = h.store.connect();
    h.transport.open();
    h.bootstraps[0]!.resolve({
      ...bootstrapFixture(1),
      stocks: null
    } as unknown as BootstrapResponse);

    expect(await settlementWithinTurn(connecting)).toBe("rejected");
    expect(h.store.connectionStatus).toBe("reconnecting");
    expect(h.transport.retryCalls).toBe(1);

    const recovered = h.store.connect();
    h.transport.open();
    h.bootstraps[1]!.resolve(bootstrapFixture(2));
    await recovered;
    expect(h.store.connectionStatus).toBe("live");
  });

  it("rejects the current connect and retries when applying a buffered event throws", async () => {
    const h = createHarness();
    const originalApplyEvent = h.trading.applyEvent;
    h.trading.applyEvent = () => {
      throw new Error("reducer failed");
    };
    const connecting = h.store.connect();
    h.transport.open();
    h.transport.message(tradeEvent(2));
    h.bootstraps[0]!.resolve(bootstrapFixture(1));

    expect(await settlementWithinTurn(connecting)).toBe("rejected");
    expect(h.store.connectionStatus).toBe("reconnecting");
    expect(h.transport.retryCalls).toBe(1);

    h.trading.applyEvent = originalApplyEvent;
    const recovered = h.store.connect();
    h.transport.open();
    h.bootstraps[1]!.resolve(bootstrapFixture(2));
    await recovered;
    expect(h.store.connectionStatus).toBe("live");
  });

  it("disconnect and dispose invalidate bootstrap work and close transport", async () => {
    const h = createHarness();
    void h.store.connect();
    h.transport.open();

    h.store.dispose();
    h.bootstraps[0]!.resolve(bootstrapFixture(20));
    await Promise.resolve();

    expect(h.store.connectionStatus).toBe("idle");
    expect(h.transport.disconnectCalls).toBe(1);
    expect(h.trading.stateVersion).toBe(0);
    h.transport.terminal();
    expect(h.store.connectionStatus).toBe("idle");
    expect(h.unauthorizedCalls()).toBe(0);
  });
});
