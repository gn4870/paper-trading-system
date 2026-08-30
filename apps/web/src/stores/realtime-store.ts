import type {
  BootstrapResponse,
  BusinessServerEvent,
  ServerEvent
} from "@paper/shared";
import { defineStore } from "pinia";
import { reactive, toRef } from "vue";

import {
  RealtimeClient,
  type RealtimeCloseInfo,
  type RealtimeClientOptions,
  type RealtimeTerminalCloseInfo
} from "../api/realtime-client.js";
import { ApiClientError, HttpClient } from "../api/http-client.js";
import { useTradingStore, type TradingStore } from "./trading-store.js";

export type ConnectionStatus =
  "idle" | "connecting" | "live" | "reconnecting" | "offline";

export interface RealtimeClientCallbacks {
  onOpen(): void;
  onMessage(event: ServerEvent): void;
  onClose(info: RealtimeCloseInfo): void;
  onProtocolError(error: Error): void;
  onTerminalError(info: RealtimeTerminalCloseInfo): void;
}

type DefaultRealtimeClientFactoryOptions = Pick<
  RealtimeClientOptions,
  "socketFactory" | "location" | "timer"
>;

export const createDefaultRealtimeClient = (
  callbacks: RealtimeClientCallbacks,
  options: DefaultRealtimeClientFactoryOptions = {}
): RealtimeClient => {
  return new RealtimeClient({
    ...options,
    ...callbacks,
    ...(import.meta.env.MODE === "e2e"
      ? { jitterRatio: 0, random: () => 0.5 }
      : {})
  });
};

export interface RealtimeTransport {
  connect(): void;
  disconnect(): void;
  retry(): void;
  markSynchronized(): void;
}

export interface BootstrapClient {
  bootstrap(): Promise<BootstrapResponse>;
}

export interface RealtimeStoreOptions {
  trading: TradingStore;
  bootstrapClient: BootstrapClient;
  createTransport(callbacks: RealtimeClientCallbacks): RealtimeTransport;
  onUnauthorized?: () => void;
}

export interface RealtimeStore {
  connectionStatus: ConnectionStatus;
  connect(): Promise<void>;
  disconnect(): void;
  dispose(): void;
  onUnauthorized(handler: () => void): () => void;
}

interface ConnectionDeferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

const createDeferred = (): ConnectionDeferred => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const isUnauthorized = (error: unknown): boolean =>
  error instanceof ApiClientError && error.status === 401;

export const createRealtimeStoreHarness = (
  options: RealtimeStoreOptions
): RealtimeStore => {
  let active = false;
  let synchronizing = false;
  let synchronizationGeneration = 0;
  let bufferedEvents: BusinessServerEvent[] = [];
  let bufferedById = new Map<string, BusinessServerEvent>();
  let bufferedByVersion = new Map<number, BusinessServerEvent>();
  let bufferConflict = false;
  let readyVersion: number | undefined;
  let connectionDeferred: ConnectionDeferred | undefined;
  const unauthorizedHandlers = new Set<() => void>();
  const state = reactive<RealtimeStore>({
    connectionStatus: "idle",
    connect: () => {
      if (active) {
        if (state.connectionStatus === "live") return Promise.resolve();
        connectionDeferred ??= createDeferred();
        return connectionDeferred.promise;
      }
      active = true;
      clearSynchronization();
      state.connectionStatus = "connecting";
      connectionDeferred = createDeferred();
      transport.connect();
      return connectionDeferred.promise;
    },
    disconnect: () => {
      if (!active && state.connectionStatus === "idle") return;
      active = false;
      clearSynchronization();
      transport.disconnect();
      state.connectionStatus = "idle";
      connectionDeferred?.resolve();
      connectionDeferred = undefined;
    },
    dispose: () => {
      state.disconnect();
      unauthorizedHandlers.clear();
    },
    onUnauthorized: (handler) => {
      unauthorizedHandlers.add(handler);
      return () => {
        unauthorizedHandlers.delete(handler);
      };
    }
  });

  const clearSynchronization = (): void => {
    synchronizationGeneration += 1;
    synchronizing = false;
    bufferedEvents = [];
    bufferedById = new Map();
    bufferedByVersion = new Map();
    bufferConflict = false;
    readyVersion = undefined;
  };

  const failConnection = (error: unknown): void => {
    const deferred = connectionDeferred;
    connectionDeferred = undefined;
    deferred?.reject(error);
  };

  const notifyUnauthorized = (): void => {
    try {
      options.onUnauthorized?.();
    } catch {
      // Auth convergence must continue through every registered consumer.
    }
    for (const handler of [...unauthorizedHandlers]) {
      try {
        handler();
      } catch {
        // One view callback cannot suppress later unauthorized handlers.
      }
    }
  };

  const stopUnauthorized = (error: unknown): void => {
    if (!active) return;
    active = false;
    clearSynchronization();
    transport.disconnect();
    state.connectionStatus = "offline";
    failConnection(error);
    notifyUnauthorized();
  };

  const requestRetry = (): void => {
    if (!active) return;
    clearSynchronization();
    state.connectionStatus = "reconnecting";
    try {
      transport.retry();
    } catch (error: unknown) {
      active = false;
      state.connectionStatus = "offline";
      failConnection(error);
    }
  };

  const failSynchronization = (error: unknown): void => {
    if (!active) return;
    clearSynchronization();
    state.connectionStatus = "reconnecting";
    failConnection(error);
    try {
      transport.retry();
    } catch (retryError: unknown) {
      active = false;
      state.connectionStatus = "offline";
      failConnection(retryError);
    }
  };

  const synchronize = async (generation: number): Promise<void> => {
    try {
      const snapshot = await options.bootstrapClient.bootstrap();
      if (!active || generation !== synchronizationGeneration || !synchronizing)
        return;
      if (
        bufferConflict ||
        (readyVersion !== undefined && snapshot.stateVersion < readyVersion)
      ) {
        requestRetry();
        return;
      }

      const orderedEvents = [...bufferedEvents].sort(
        (left, right) =>
          left.stateVersion - right.stateVersion ||
          left.eventId.localeCompare(right.eventId)
      );
      options.trading.replaceSnapshot(snapshot);
      for (const event of orderedEvents) {
        if (event.stateVersion > snapshot.stateVersion)
          options.trading.applyEvent(event);
      }

      if (!active || generation !== synchronizationGeneration) return;
      synchronizing = false;
      bufferedEvents = [];
      bufferedById.clear();
      bufferedByVersion.clear();
      readyVersion = undefined;
      state.connectionStatus = "live";
      transport.markSynchronized();
      const deferred = connectionDeferred;
      connectionDeferred = undefined;
      deferred?.resolve();
    } catch (error: unknown) {
      if (!active || generation !== synchronizationGeneration) return;
      if (isUnauthorized(error)) {
        stopUnauthorized(error);
      } else {
        failSynchronization(error);
      }
    } finally {
      if (generation === synchronizationGeneration) synchronizing = false;
    }
  };

  const beginSynchronization = (): void => {
    if (!active) return;
    synchronizationGeneration += 1;
    const generation = synchronizationGeneration;
    synchronizing = true;
    bufferedEvents = [];
    bufferedById = new Map();
    bufferedByVersion = new Map();
    bufferConflict = false;
    readyVersion = undefined;
    void synchronize(generation);
  };

  const bufferEvent = (event: BusinessServerEvent): void => {
    const sameId = bufferedById.get(event.eventId);
    if (sameId !== undefined) {
      if (
        sameId.stateVersion !== event.stateVersion ||
        sameId.type !== event.type
      ) {
        bufferConflict = true;
      }
      return;
    }
    const sameVersion = bufferedByVersion.get(event.stateVersion);
    if (sameVersion !== undefined && sameVersion.eventId !== event.eventId) {
      bufferConflict = true;
      return;
    }
    bufferedById.set(event.eventId, event);
    bufferedByVersion.set(event.stateVersion, event);
    bufferedEvents.push(event);
  };

  const handleMessage = (event: ServerEvent): void => {
    if (!active || event.type === "heartbeat") return;
    if (event.type === "connection.ready") {
      if (synchronizing) {
        readyVersion = Math.max(readyVersion ?? 0, event.stateVersion);
      } else if (
        state.connectionStatus === "live" &&
        event.stateVersion > options.trading.stateVersion
      ) {
        requestRetry();
      }
      return;
    }
    if (synchronizing) {
      bufferEvent(event);
      return;
    }
    if (state.connectionStatus !== "live") return;
    if (event.stateVersion === options.trading.stateVersion) {
      if (!options.trading.appliedEventIds.includes(event.eventId))
        requestRetry();
      return;
    }
    if (event.stateVersion > options.trading.stateVersion) {
      options.trading.applyEvent(event);
    }
  };

  const callbacks: RealtimeClientCallbacks = {
    onOpen: () => {
      if (!active) return;
      beginSynchronization();
    },
    onMessage: handleMessage,
    onProtocolError: () => {
      if (active) requestRetry();
    },
    onClose: ({ retryDelayMs }) => {
      if (!active) return;
      clearSynchronization();
      state.connectionStatus =
        retryDelayMs === null ? "offline" : "reconnecting";
      if (retryDelayMs === null) {
        active = false;
      }
    },
    onTerminalError: (info) => {
      if (!active) return;
      active = false;
      clearSynchronization();
      state.connectionStatus = "offline";
      failConnection(info.error);
      if (info.code === 1008) notifyUnauthorized();
    }
  };
  const transport = options.createTransport(callbacks);

  return state;
};

export const useRealtimeStore = defineStore("realtime", () => {
  const http = new HttpClient();
  const harness = createRealtimeStoreHarness({
    trading: useTradingStore(),
    bootstrapClient: {
      bootstrap: () => http.bootstrap()
    },
    createTransport: (callbacks) => createDefaultRealtimeClient(callbacks)
  });
  return {
    connectionStatus: toRef(harness, "connectionStatus"),
    connect: harness.connect,
    disconnect: harness.disconnect,
    dispose: harness.dispose,
    onUnauthorized: harness.onUnauthorized
  };
});
