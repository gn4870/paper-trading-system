import type { ServerEvent } from "@paper/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RealtimeClient,
  type RealtimeSocket,
  type RealtimeSocketFactory
} from "./realtime-client.js";

class FakeSocket implements RealtimeSocket {
  readonly url: string;
  readyState: number = WebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closeCalls: Array<{ code: number | undefined; reason: string | undefined }> =
    [];

  constructor(url: string) {
    this.url = url;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  message(payload: unknown): void {
    this.onmessage?.(
      new MessageEvent("message", {
        data: typeof payload === "string" ? payload : JSON.stringify(payload)
      })
    );
  }

  closeUnexpectedly(code = 1006, reason = "network lost"): void {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason, wasClean: false }));
  }

  close(code?: number, reason?: string): void {
    if (
      code !== undefined &&
      code !== 1_000 &&
      (code < 3_000 || code > 4_999)
    ) {
      throw new DOMException(
        "Invalid WebSocket close code",
        "InvalidAccessError"
      );
    }
    this.closeCalls.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
    this.onclose?.(
      new CloseEvent("close", {
        code: code ?? 1000,
        reason: reason ?? "",
        wasClean: true
      })
    );
  }
}

const eventFixture = (stateVersion = 1): ServerEvent => ({
  type: "market.updated",
  eventId: `event-${stateVersion}`,
  stateVersion,
  occurredAt: "2026-08-29T00:00:00.000Z",
  payload: {
    symbol: "AAPL",
    name: "Apple",
    openPriceMinor: 10_000,
    lastPriceMinor: 10_100,
    changePercent: 1,
    bestBidMinor: 10_099,
    bestAskMinor: 10_101,
    history: [{ priceMinor: 10_100, at: "2026-08-29T00:00:00.000Z" }]
  }
});

const orderEventFixture = (): Record<string, unknown> => ({
  type: "order.updated",
  eventId: "event-13",
  stateVersion: 13,
  occurredAt: "2026-08-29T00:00:00.000Z",
  payload: {
    id: "order-1",
    clientOrderId: "client-order-1",
    userId: "user-1",
    symbol: "AAPL",
    side: "BUY",
    limitPriceMinor: 10_000,
    originalQuantity: 10,
    remainingQuantity: 10,
    status: "OPEN",
    sequence: 1,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z"
  }
});

const accountEventFixture = (): Record<string, unknown> => ({
  type: "account.updated",
  eventId: "event-account",
  stateVersion: 13,
  occurredAt: "2026-08-29T00:00:00.000Z",
  payload: {
    userId: "user-1",
    cashAvailableMinor: 10_000,
    cashFrozenMinor: 0,
    positions: {
      AAPL: { availableQuantity: 1, frozenQuantity: 0 },
      MSFT: { availableQuantity: 0, frozenQuantity: 0 },
      TSLA: { availableQuantity: 0, frozenQuantity: 0 }
    }
  }
});

const tradeEventFixture = (): Record<string, unknown> => ({
  type: "trade.created",
  eventId: "event-trade",
  stateVersion: 13,
  occurredAt: "2026-08-29T00:00:00.000Z",
  payload: {
    id: "trade-1",
    symbol: "AAPL",
    buyOrderId: "buy-1",
    sellOrderId: "sell-1",
    buyerId: "user-1",
    sellerId: "user-2",
    priceMinor: 10_000,
    quantity: 1,
    executedAt: "2026-08-29T00:00:00.000Z",
    sequence: 1
  }
});

const change = (
  fixture: () => Record<string, unknown>,
  mutate: (message: Record<string, unknown>) => void
): Record<string, unknown> => {
  const message = structuredClone(fixture());
  mutate(message);
  return message;
};

const nested = (
  value: Record<string, unknown>,
  key: string
): Record<string, unknown> => value[key] as Record<string, unknown>;

const createHarness = (protocol = "http:") => {
  const sockets: FakeSocket[] = [];
  const messages: ServerEvent[] = [];
  const delays: number[] = [];
  const terminalErrors: unknown[] = [];
  const protocolErrors: unknown[] = [];
  const factory: RealtimeSocketFactory = (url) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket;
  };
  const client = new RealtimeClient({
    socketFactory: factory,
    location: { protocol, host: "trade.example.test" },
    jitterRatio: 0,
    random: () => 0.5,
    onMessage: (value) => messages.push(value),
    onClose: ({ retryDelayMs }) => {
      if (retryDelayMs !== null) delays.push(retryDelayMs);
    },
    onTerminalError: (error) => terminalErrors.push(error),
    onProtocolError: (error) => protocolErrors.push(error)
  });
  return { client, sockets, messages, delays, terminalErrors, protocolErrors };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("RealtimeClient", () => {
  it.each([
    ["http:", "ws://trade.example.test/ws"],
    ["https:", "wss://trade.example.test/ws"]
  ])("uses a same-origin websocket URL for %s", (protocol, expected) => {
    const h = createHarness(protocol);

    h.client.connect();

    expect(h.sockets[0]?.url).toBe(expected);
    h.client.disconnect();
  });

  it("delivers valid protocol messages and isolates malformed or unknown messages", () => {
    const h = createHarness();
    h.client.connect();
    h.sockets[0]!.open();

    h.sockets[0]!.message(eventFixture());
    h.sockets[0]!.message("{not-json");
    h.sockets[0]!.message({ type: "future.event", payload: {} });

    expect(h.messages).toEqual([eventFixture()]);
    expect(h.terminalErrors).toEqual([]);
    expect(h.protocolErrors).toEqual([]);
    expect(h.sockets[0]?.readyState).toBe(WebSocket.OPEN);
    h.client.disconnect();
  });

  it("reports known event types with invalid metadata or payload while ignoring future types", () => {
    const h = createHarness();
    h.client.connect();
    h.sockets[0]!.open();

    h.sockets[0]!.message({ ...orderEventFixture(), eventId: "" });
    h.sockets[0]!.message({ type: "heartbeat", occurredAt: "" });
    h.sockets[0]!.message({ type: "future.event", payload: {} });

    expect(h.messages).toEqual([]);
    expect(h.protocolErrors).toHaveLength(2);
    h.client.disconnect();
  });

  it("rejects domain-invalid payloads for every known business event", () => {
    const invalidMessages = [
      change(
        () => eventFixture() as unknown as Record<string, unknown>,
        (message) => {
          nested(message, "payload").openPriceMinor = 1.5;
        }
      ),
      change(
        () => eventFixture() as unknown as Record<string, unknown>,
        (message) => {
          nested(message, "payload").bestBidMinor = 10_200;
          nested(message, "payload").bestAskMinor = 10_100;
        }
      ),
      change(
        () => eventFixture() as unknown as Record<string, unknown>,
        (message) => {
          const history = nested(message, "payload").history as Array<
            Record<string, unknown>
          >;
          history[0]!.priceMinor = 0;
        }
      ),
      change(orderEventFixture, (message) => {
        nested(message, "payload").id = "";
      }),
      change(orderEventFixture, (message) => {
        nested(message, "payload").symbol = "NVDA";
      }),
      change(orderEventFixture, (message) => {
        nested(message, "payload").side = "HOLD";
      }),
      change(orderEventFixture, (message) => {
        nested(message, "payload").status = "PENDING";
      }),
      change(orderEventFixture, (message) => {
        nested(message, "payload").limitPriceMinor = 0;
      }),
      change(orderEventFixture, (message) => {
        nested(message, "payload").sequence = -1;
      }),
      change(orderEventFixture, (message) => {
        nested(message, "payload").sequence = 0;
      }),
      change(orderEventFixture, (message) => {
        nested(message, "payload").remainingQuantity = 11;
      }),
      change(orderEventFixture, (message) => {
        nested(message, "payload").status = "FILLED";
        nested(message, "payload").remainingQuantity = 1;
      }),
      change(accountEventFixture, (message) => {
        nested(message, "payload").cashAvailableMinor = -1;
      }),
      change(accountEventFixture, (message) => {
        delete nested(nested(message, "payload"), "positions").TSLA;
      }),
      change(accountEventFixture, (message) => {
        nested(
          nested(nested(message, "payload"), "positions"),
          "AAPL"
        ).availableQuantity = 0.5;
      }),
      change(tradeEventFixture, (message) => {
        nested(message, "payload").id = "";
      }),
      change(tradeEventFixture, (message) => {
        nested(message, "payload").priceMinor = 0;
      }),
      change(tradeEventFixture, (message) => {
        nested(message, "payload").quantity = 0;
      }),
      change(tradeEventFixture, (message) => {
        nested(message, "payload").sequence = 0;
      }),
      change(tradeEventFixture, (message) => {
        nested(message, "payload").sequence = 1.5;
      })
    ];
    const h = createHarness();
    h.client.connect();
    h.sockets[0]!.open();

    for (const message of invalidMessages) h.sockets[0]!.message(message);

    expect(h.messages).toEqual([]);
    expect(h.protocolErrors).toHaveLength(invalidMessages.length);
    h.client.disconnect();
  });

  it("reconnects with exponential backoff capped at ten seconds", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    h.client.connect();

    for (let attempt = 0; attempt < 7; attempt += 1) {
      h.sockets.at(-1)!.closeUnexpectedly();
      await vi.advanceTimersByTimeAsync(h.delays.at(-1)!);
    }

    expect(h.delays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
    expect(h.sockets).toHaveLength(8);
    h.client.disconnect();
  });

  it("abandons a silent open socket after ten seconds and retries", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    h.client.connect();
    h.sockets[0]!.open();

    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.delays).toEqual([]);
    expect(h.sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.delays).toEqual([500]);
    expect(h.sockets[0]?.closeCalls).toEqual([
      { code: 4_000, reason: "liveness timeout" }
    ]);

    await vi.advanceTimersByTimeAsync(500);
    expect(h.sockets).toHaveLength(2);
    h.client.disconnect();
  });

  it("uses an application close code and retries after a socket error", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    h.client.connect();
    h.sockets[0]!.open();

    expect(() => h.sockets[0]!.onerror?.(new Event("error"))).not.toThrow();

    expect(h.sockets[0]?.closeCalls).toEqual([
      { code: 4_000, reason: "websocket error" }
    ]);
    expect(h.delays).toEqual([500]);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.sockets).toHaveLength(2);
    h.client.disconnect();
  });

  it("still retries when closing a socket after an error throws", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    h.client.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.close = () => {
      throw new DOMException("socket unavailable", "InvalidStateError");
    };

    expect(() => h.sockets[0]!.onerror?.(new Event("error"))).not.toThrow();
    expect(h.delays).toEqual([500]);

    await vi.advanceTimersByTimeAsync(500);
    expect(h.sockets).toHaveLength(2);
    h.client.disconnect();
  });

  it("resets the liveness deadline whenever a valid message arrives", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    h.client.connect();
    h.sockets[0]!.open();

    await vi.advanceTimersByTimeAsync(9_000);
    h.sockets[0]!.message({
      type: "heartbeat",
      occurredAt: "2026-08-29T00:00:09.000Z"
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.delays).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.delays).toEqual([500]);
    h.client.disconnect();
  });

  it("still retries when closing an expired socket throws", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    h.client.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.close = () => {
      throw new DOMException("socket unavailable", "InvalidStateError");
    };

    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.delays).toEqual([500]);
    h.client.disconnect();
  });

  it("resets backoff only when synchronization is confirmed", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    h.client.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.closeUnexpectedly();
    await vi.advanceTimersByTimeAsync(500);
    h.sockets[1]!.open();
    h.sockets[1]!.closeUnexpectedly();
    await vi.advanceTimersByTimeAsync(1_000);
    h.sockets[2]!.open();

    h.client.markSynchronized();
    h.sockets[2]!.closeUnexpectedly();

    expect(h.delays).toEqual([500, 1_000, 500]);
    h.client.disconnect();
  });

  it("does not reconnect after an active disconnect", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    h.client.connect();
    const socket = h.sockets[0]!;

    h.client.disconnect();
    socket.closeUnexpectedly();
    await vi.runAllTimersAsync();

    expect(socket.closeCalls).toEqual([
      { code: 1000, reason: "client disconnect" }
    ]);
    expect(h.sockets).toHaveLength(1);
    expect(h.delays).toEqual([]);
  });

  it("coalesces repeated resynchronization retries into one closing socket and timer", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    h.client.connect();
    h.sockets[0]!.open();

    h.client.retry();
    h.client.retry();

    expect(h.sockets[0]?.closeCalls).toEqual([
      { code: 4_000, reason: "resynchronization failed" }
    ]);
    expect(h.delays).toEqual([500]);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.sockets).toHaveLength(2);
    h.client.disconnect();
  });

  it("treats a policy close as terminal and ignores stale socket callbacks", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    h.client.connect();
    const first = h.sockets[0]!;
    first.closeUnexpectedly();
    await vi.advanceTimersByTimeAsync(500);
    const second = h.sockets[1]!;

    first.message(eventFixture(99));
    first.closeUnexpectedly(1008, "stale session rejected");
    second.closeUnexpectedly(1008, "session expired");
    await vi.runAllTimersAsync();

    expect(h.messages).toEqual([]);
    expect(h.terminalErrors).toHaveLength(1);
    expect(h.terminalErrors[0]).toMatchObject({
      code: 1008,
      reason: "session expired",
      error: expect.any(Error)
    });
    expect(h.sockets).toHaveLength(2);
  });
});
