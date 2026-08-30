import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  RealtimeSocketFactory,
  RealtimeTimer
} from "../api/realtime-client.js";
import {
  createDefaultRealtimeClient,
  type RealtimeClientCallbacks
} from "./realtime-store.js";

const retryDelayForMode = (mode: string): number => {
  vi.stubEnv("MODE", mode);
  let retryDelay = -1;
  const socketFactory: RealtimeSocketFactory = () => {
    throw new Error("socket unavailable");
  };
  const timer: RealtimeTimer = {
    setTimeout: () => 1,
    clearTimeout: () => undefined
  };
  const callbacks: RealtimeClientCallbacks = {
    onOpen: () => undefined,
    onMessage: () => undefined,
    onClose: ({ retryDelayMs }) => {
      retryDelay = retryDelayMs ?? -1;
    },
    onProtocolError: () => undefined,
    onTerminalError: () => undefined
  };
  const client = createDefaultRealtimeClient(callbacks, {
    socketFactory,
    timer,
    location: { protocol: "http:", host: "trade.example.test" }
  });

  client.connect();
  client.disconnect();
  return retryDelay;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("default realtime client mode", () => {
  it("removes reconnect jitter from the E2E build mode", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);

    expect(retryDelayForMode("e2e")).toBe(500);
  });

  it("keeps Math.random and the 20% jitter default in production", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(1);

    expect(retryDelayForMode("production")).toBe(600);
    expect(random).toHaveBeenCalledOnce();
  });
});
