import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import net from "node:net";

import type { ServerEvent } from "@paper/shared";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { AccountLedger } from "../accounts/account-ledger.js";
import { AuthService } from "../auth/auth-service.js";
import { createApp } from "../http/app.js";
import {
  EventJournal,
  type EventDraft
} from "../infrastructure/event-journal.js";
import { MemoryState } from "../infrastructure/memory-state.js";
import { MarketSimulator } from "../market/market-simulator.js";
import { OrderService } from "../orders/order-service.js";
import {
  RealtimeHub,
  type RealtimeHubOptions,
  type RealtimeScheduler
} from "./realtime-hub.js";

const instant = "2026-08-29T00:00:00.000Z";

class EventReader {
  private readonly messages: ServerEvent[] = [];
  private readonly waiters: Array<(event: ServerEvent) => void> = [];

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString()) as ServerEvent;
      const waiter = this.waiters.shift();
      if (waiter === undefined) this.messages.push(event);
      else waiter(event);
    });
  }

  next(): Promise<ServerEvent> {
    const message = this.messages.shift();
    if (message !== undefined) return Promise.resolve(message);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for WebSocket event")),
        1_000
      );
      this.waiters.push((event) => {
        clearTimeout(timeout);
        resolve(event);
      });
    });
  }

  async nextTypes(count: number): Promise<string[]> {
    return Promise.all(
      Array.from({ length: count }, async () => (await this.next()).type)
    );
  }

  async expectNoMessage(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(this.messages).toEqual([]);
  }
}

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
};

const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
};

const rejectedUpgrade = async (
  port: number,
  path: string,
  cookie?: string
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for rejected upgrade"));
    }, 1_000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("error", () => undefined);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve(response);
    });
    socket.once("connect", () => {
      const headers = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="
      ];
      if (cookie !== undefined) headers.push(`Cookie: ${cookie}`);
      socket.write(`${headers.join("\r\n")}\r\n\r\n`);
    });
  });
};

const openSocket = async (
  port: number,
  sessionId: string
): Promise<EventReader> => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: {
      Cookie: `theme=dark; paper_session=${encodeURIComponent(sessionId)}; mode=compact`
    }
  });
  const reader = new EventReader(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return reader;
};

const rejectedSession = async (
  port: number,
  cookie?: string
): Promise<{ closeCode: number; messages: number }> => {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: cookie === undefined ? undefined : { Cookie: cookie }
    });
    let messages = 0;
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("Timed out waiting for session rejection"));
    }, 1_000);
    socket.on("message", () => {
      messages += 1;
    });
    socket.on("error", () => undefined);
    socket.once("close", (closeCode) => {
      clearTimeout(timeout);
      resolve({ closeCode, messages });
    });
  });
};

const createRealtimeHarness = async (options: RealtimeHubOptions = {}) => {
  const state = new MemoryState();
  const ledger = new AccountLedger(state);
  const clock = { now: () => instant };
  const ids = { next: () => crypto.randomUUID() };
  const journal = new EventJournal(clock, ids);
  const auth = new AuthService(state, ledger);
  for (const userId of ["first", "second"]) {
    state.users.set(userId, {
      id: userId,
      username: userId,
      normalizedUsername: userId,
      passwordDigest: "unused",
      kind: "REAL"
    });
    state.sessions.set(`session:${userId}`, {
      id: `session:${userId}`,
      userId,
      createdAt: instant
    });
  }

  const market = new MarketSimulator(state, journal, clock, {
    next: () => 0.5
  });
  market.initialize();
  const orders = new OrderService(state, ledger, journal, clock, ids);
  const server = createServer(
    createApp({
      state,
      ledger,
      auth,
      orders,
      market,
      journal,
      log: () => undefined
    })
  );
  const hub = new RealtimeHub(auth, journal, {
    now: () => instant,
    ...options
  });
  hub.attach(server);
  hub.attach(server);
  const port = await listen(server);
  const readers: EventReader[] = [];

  return {
    auth,
    journal,
    port,
    startHeartbeat: () => hub.startHeartbeat(),
    async connectUser(userId: "first" | "second") {
      const reader = await openSocket(port, `session:${userId}`);
      readers.push(reader);
      const ready = await reader.next();
      expect(ready).toEqual({
        type: "connection.ready",
        stateVersion: journal.currentVersion,
        occurredAt: instant
      });
      return reader;
    },
    async logoutUser(userId: "first" | "second") {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
        method: "POST",
        headers: { Cookie: `paper_session=session:${userId}` }
      });
      return response.status;
    },
    async stop() {
      for (const reader of readers) reader.socket.terminate();
      await hub.stop();
      await closeServer(server);
    }
  };
};

const marketDraft = (): EventDraft => ({
  type: "market.updated",
  audience: { kind: "public" },
  payload: {
    symbol: "AAPL",
    name: "Apple",
    openPriceMinor: 18_700,
    lastPriceMinor: 18_710,
    changePercent: 0.05,
    bestBidMinor: 18_700,
    bestAskMinor: 18_720,
    history: [{ priceMinor: 18_710, at: instant }]
  }
});

const accountDraft = (userId: string): EventDraft => ({
  type: "account.updated",
  audience: { kind: "user", userId },
  payload: {
    userId,
    cashAvailableMinor: 100,
    cashFrozenMinor: 0,
    positions: {
      AAPL: { availableQuantity: 0, frozenQuantity: 0 },
      MSFT: { availableQuantity: 0, frozenQuantity: 0 },
      TSLA: { availableQuantity: 0, frozenQuantity: 0 }
    }
  }
});

const serializedMarketBytes = (): number => {
  const draft = marketDraft();
  return Buffer.byteLength(
    JSON.stringify({
      type: draft.type,
      payload: draft.payload,
      eventId: "0".repeat(36),
      stateVersion: 1,
      occurredAt: instant
    })
  );
};

describe("RealtimeHub", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("closes upgraded /ws connections with policy violation for invalid sessions", async () => {
    const h = await createRealtimeHarness();
    cleanups.push(h.stop);

    const missing = await rejectedSession(h.port);
    const invalid = await rejectedSession(h.port, "paper_session=missing");

    expect(missing).toEqual({ closeCode: 1008, messages: 0 });
    expect(invalid).toEqual({ closeCode: 1008, messages: 0 });
  });

  it("upgrades only the exact WebSocket path", async () => {
    const h = await createRealtimeHarness();
    cleanups.push(h.stop);

    const response = await rejectedUpgrade(
      h.port,
      "/ws/commands",
      `paper_session=${encodeURIComponent("session:first")}`
    );

    expect(response).not.toContain("101 Switching Protocols");
  });

  it("accepts an encoded session among multiple cookies", async () => {
    const h = await createRealtimeHarness();
    cleanups.push(h.stop);
    h.journal.publish([marketDraft()]);

    const first = await h.connectUser("first");

    expect(first.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("broadcasts public events in journal order and isolates private events", async () => {
    const h = await createRealtimeHarness();
    cleanups.push(h.stop);
    const first = await h.connectUser("first");
    const second = await h.connectUser("second");

    const published = h.journal.publish([marketDraft(), accountDraft("first")]);

    expect(await first.nextTypes(2)).toEqual([
      "market.updated",
      "account.updated"
    ]);
    expect(await second.nextTypes(1)).toEqual(["market.updated"]);
    expect(published.map((event) => event.stateVersion)).toEqual([1, 2]);
    await second.expectNoMessage();
  });

  it("closes the logged-out session with 1008 without affecting another user", async () => {
    const h = await createRealtimeHarness();
    cleanups.push(h.stop);
    const first = await h.connectUser("first");
    const second = await h.connectUser("second");
    const firstClosed = new Promise<number>((resolve) => {
      first.socket.once("close", (code) => resolve(code));
    });

    await expect(h.logoutUser("first")).resolves.toBe(204);
    await expect(firstClosed).resolves.toBe(1008);
    await expect(h.logoutUser("first")).resolves.toBe(204);
    h.journal.publish([
      accountDraft("first"),
      marketDraft(),
      accountDraft("second")
    ]);

    expect(await second.nextTypes(2)).toEqual([
      "market.updated",
      "account.updated"
    ]);
    await first.expectNoMessage();
  });

  it("never exposes a non-market event even when mislabeled public", async () => {
    const h = await createRealtimeHarness();
    cleanups.push(h.stop);
    const first = await h.connectUser("first");
    const second = await h.connectUser("second");
    const mislabeled = {
      ...accountDraft("first"),
      audience: { kind: "public" as const }
    };

    h.journal.publish([mislabeled, marketDraft()]);

    expect(await first.nextTypes(1)).toEqual(["market.updated"]);
    expect(await second.nextTypes(1)).toEqual(["market.updated"]);
    await first.expectNoMessage();
    await second.expectNoMessage();
  });

  it("keeps sibling trade deliveries private to buyer and seller", async () => {
    const h = await createRealtimeHarness();
    cleanups.push(h.stop);
    const first = await h.connectUser("first");
    const second = await h.connectUser("second");
    const trade = {
      id: "trade-1",
      symbol: "AAPL" as const,
      buyOrderId: "buy-1",
      sellOrderId: "sell-1",
      buyerId: "first",
      sellerId: "second",
      priceMinor: 18_710,
      quantity: 1,
      executedAt: instant,
      sequence: 1
    };

    h.journal.publish([
      {
        type: "trade.created",
        audience: { kind: "user", userId: "first" },
        payload: trade
      },
      {
        type: "trade.created",
        audience: { kind: "user", userId: "second" },
        payload: trade
      }
    ]);

    expect(await first.nextTypes(1)).toEqual(["trade.created"]);
    expect(await second.nextTypes(1)).toEqual(["trade.created"]);
  });

  it("broadcasts an application heartbeat every three seconds", async () => {
    const callbacks = new Map<number, () => void>();
    const scheduler: RealtimeScheduler = {
      setInterval: (callback, delayMs) => {
        callbacks.set(delayMs, callback);
        return delayMs;
      },
      clearInterval: () => undefined
    };
    const h = await createRealtimeHarness({ scheduler });
    cleanups.push(h.stop);
    const first = await h.connectUser("first");

    h.startHeartbeat();

    expect([...callbacks.keys()].sort((left, right) => left - right)).toEqual([
      3_000, 20_000
    ]);
    callbacks.get(3_000)!();
    expect(await first.next()).toEqual({
      type: "heartbeat",
      occurredAt: instant
    });
  });

  it("uses ping control frames and terminates a half-open client after 60 seconds", async () => {
    let now = 0;
    let callback: (() => void) | undefined;
    const clearedIntervals: number[] = [];
    const scheduler: RealtimeScheduler = {
      setInterval: (next, delayMs) => {
        if (delayMs === 20_000) callback = next;
        return delayMs;
      },
      clearInterval: (handle) => {
        clearedIntervals.push(handle as number);
      }
    };
    const h = await createRealtimeHarness({ scheduler, nowMs: () => now });
    cleanups.push(h.stop);
    const first = await h.connectUser("first");
    const closed = new Promise<void>((resolve) => {
      first.socket.once("close", () => resolve());
    });
    first.socket.pause();

    h.startHeartbeat();
    h.startHeartbeat();
    for (now = 20_000; now <= 60_000; now += 20_000) callback!();
    first.socket.resume();
    await closed;

    await first.expectNoMessage();
    await h.stop();
    expect(clearedIntervals.sort((left, right) => left - right)).toEqual([
      3_000, 20_000
    ]);
  });

  it("ignores client messages and keeps other authenticated clients live", async () => {
    const h = await createRealtimeHarness();
    cleanups.push(h.stop);
    const first = await h.connectUser("first");
    const second = await h.connectUser("second");

    first.socket.send(JSON.stringify({ type: "order.place", quantity: 999 }));
    first.socket.terminate();
    h.journal.publish([marketDraft()]);

    expect(await second.nextTypes(1)).toEqual(["market.updated"]);
    await second.expectNoMessage();
  });

  it("terminates without sending when one serialized event exceeds the buffer limit", async () => {
    const eventBytes = serializedMarketBytes();
    const h = await createRealtimeHarness({
      maxBufferedBytes: eventBytes - 1
    });
    cleanups.push(h.stop);
    const first = await h.connectUser("first");
    const outcome = Promise.race([
      first.next().then(() => "message" as const),
      new Promise<"closed">((resolve) => {
        first.socket.once("close", () => resolve("closed"));
      })
    ]);

    h.journal.publish([marketDraft()]);

    expect(await outcome).toBe("closed");
  });

  it("terminates at the exact cumulative buffered-byte limit", async () => {
    const eventBytes = serializedMarketBytes();
    const existingBufferedBytes = 64;
    let bufferedBytes = 0;
    const h = await createRealtimeHarness({
      maxBufferedBytes: eventBytes + existingBufferedBytes,
      bufferedAmount: () => bufferedBytes
    });
    cleanups.push(h.stop);
    const first = await h.connectUser("first");
    bufferedBytes = existingBufferedBytes;
    const outcome = Promise.race([
      first.next().then(() => "message" as const),
      new Promise<"closed">((resolve) => {
        first.socket.once("close", () => resolve("closed"));
      })
    ]);

    h.journal.publish([marketDraft()]);

    expect(await outcome).toBe("closed");
  });
});
