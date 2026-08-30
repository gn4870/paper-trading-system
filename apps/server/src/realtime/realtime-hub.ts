/**
 * 服务端 WebSocket 网关。
 *
 * 它用同一个 HttpOnly Session Cookie 鉴权，只向用户发送公共行情和属于自己的
 * 私有订单/账户/成交事件；同时负责心跳、慢客户端隔离和退出后的连接撤销。
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import type { ServerEvent } from "@paper/shared";
import { parseCookie } from "cookie";
import { WebSocket, WebSocketServer } from "ws";

import { AuthService } from "../auth/auth-service.js";
import {
  EventJournal,
  type JournalEvent
} from "../infrastructure/event-journal.js";
import { SESSION_COOKIE } from "../http/auth-middleware.js";

export interface RealtimeScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface RealtimeHubOptions {
  now?: () => string;
  nowMs?: () => number;
  scheduler?: RealtimeScheduler;
  heartbeatIntervalMs?: number;
  clientTimeoutMs?: number;
  maxBufferedBytes?: number;
  bufferedAmount?: (client: WebSocket) => number;
}

interface ClientState {
  userId: string;
  sessionId: string;
  lastPongAt: number;
  lastStateVersion: number;
}

const defaultScheduler: RealtimeScheduler = {
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: (handle) =>
    globalThis.clearInterval(
      handle as ReturnType<typeof globalThis.setInterval>
    )
};

const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
const DEFAULT_CLIENT_TIMEOUT_MS = 60_000;
const APPLICATION_HEARTBEAT_INTERVAL_MS = 3_000;
const DEFAULT_MAX_BUFFERED_BYTES = 1_000_000;

export class RealtimeHub {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly clients = new Map<WebSocket, ClientState>();
  private readonly now: () => string;
  private readonly nowMs: () => number;
  private readonly scheduler: RealtimeScheduler;
  private readonly heartbeatIntervalMs: number;
  private readonly clientTimeoutMs: number;
  private readonly maxBufferedBytes: number;
  private readonly bufferedAmount: (client: WebSocket) => number;
  private attachedServer: Server | undefined;
  private unsubscribeJournal: (() => void) | undefined;
  private unsubscribeSessionInvalidation: (() => void) | undefined;
  private heartbeatTimer: unknown | undefined;
  private applicationHeartbeatTimer: unknown | undefined;
  private stopped = false;
  private stopPromise: Promise<void> | undefined;

  constructor(
    private readonly auth: AuthService,
    private readonly journal: EventJournal,
    options: RealtimeHubOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.nowMs = options.nowMs ?? Date.now;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.clientTimeoutMs = options.clientTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
    this.maxBufferedBytes =
      options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.bufferedAmount =
      options.bufferedAmount ?? ((client) => client.bufferedAmount);
  }

  attach(server: Server): void {
    if (this.stopped) throw new Error("RealtimeHub is stopped");
    if (this.attachedServer === server) return;
    if (this.attachedServer !== undefined) {
      throw new Error("RealtimeHub is already attached");
    }

    this.attachedServer = server;
    server.on("upgrade", this.handleUpgrade);
    // 业务模块只发布到 EventJournal，不直接依赖 WebSocket 传输。
    this.unsubscribeJournal = this.journal.subscribe((event) => {
      this.deliver(event);
    });
    this.unsubscribeSessionInvalidation = this.auth.onSessionInvalidated(
      (sessionId) => {
        this.invalidateSession(sessionId);
      }
    );
  }

  startHeartbeat(): void {
    if (this.stopped) return;
    // ping/pong 用于服务端清理半开连接；应用层 heartbeat 让浏览器也能检测到
    // “TCP 尚未关闭但服务端已不再发送业务消息”的假在线状态。
    if (this.heartbeatTimer === undefined) {
      this.heartbeatTimer = this.scheduler.setInterval(() => {
        this.pingClients();
      }, this.heartbeatIntervalMs);
    }
    if (this.applicationHeartbeatTimer === undefined) {
      this.applicationHeartbeatTimer = this.scheduler.setInterval(() => {
        this.broadcastHeartbeat();
      }, APPLICATION_HEARTBEAT_INTERVAL_MS);
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = this.stopOnce();
    return this.stopPromise;
  }

  private readonly handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void => {
    // 只接受精确 /ws，避免普通 HTTP 或相似路径被误升级。
    if (this.stopped || request.url !== "/ws") {
      socket.destroy();
      return;
    }

    const sessionId = this.sessionIdFrom(request);
    const user =
      sessionId === undefined ? undefined : this.auth.resolveSession(sessionId);

    try {
      this.wss.handleUpgrade(request, socket, head, (client) => {
        if (user === undefined) {
          client.once("error", () => undefined);
          client.close(1008, "Invalid session");
        } else {
          this.accept(client, user.id, sessionId!);
        }
      });
    } catch {
      socket.destroy();
    }
  };

  private sessionIdFrom(request: IncomingMessage): string | undefined {
    const header = request.headers.cookie;
    if (header === undefined) return undefined;
    try {
      const value = parseCookie(header)[SESSION_COOKIE];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private accept(client: WebSocket, userId: string, sessionId: string): void {
    if (this.stopped) {
      this.terminate(client);
      return;
    }

    // 新连接从当前版本开始；历史缺口由客户端紧接着请求 bootstrap 快照恢复。
    const state: ClientState = {
      userId,
      sessionId,
      lastPongAt: this.nowMs(),
      lastStateVersion: this.journal.currentVersion
    };
    this.clients.set(client, state);
    client.on("pong", () => {
      const current = this.clients.get(client);
      if (current !== undefined) current.lastPongAt = this.nowMs();
    });
    client.once("close", () => {
      this.clients.delete(client);
    });
    client.once("error", () => {
      this.terminate(client);
    });
    this.send(client, {
      type: "connection.ready",
      stateVersion: state.lastStateVersion,
      occurredAt: this.now()
    });
  }

  private deliver(event: JournalEvent): void {
    const { audience, ...serverEvent } = event;
    for (const [client, state] of this.clients) {
      if (
        event.stateVersion <= state.lastStateVersion ||
        (audience.kind === "public" && event.type !== "market.updated") ||
        (audience.kind === "user" && audience.userId !== state.userId)
      ) {
        continue;
      }
      // 全局版本允许跳号：中间版本可能是其他用户不可见的私有事件。
      if (this.send(client, serverEvent)) {
        state.lastStateVersion = event.stateVersion;
      }
    }
  }

  private send(client: WebSocket, event: ServerEvent): boolean {
    if (client.readyState !== WebSocket.OPEN) return false;

    try {
      const serialized = JSON.stringify(event);
      const bufferedAmount = this.bufferedAmount(client);
      const nextBufferedAmount = bufferedAmount + Buffer.byteLength(serialized);
      // 不让慢客户端无限堆积内存；达到阈值时主动断开并让客户端走快照重连。
      if (
        !Number.isFinite(bufferedAmount) ||
        bufferedAmount < 0 ||
        nextBufferedAmount >= this.maxBufferedBytes
      ) {
        this.terminate(client);
        return false;
      }
      client.send(serialized, (error) => {
        if (error) this.terminate(client);
      });
      return true;
    } catch {
      return false;
    }
  }

  private pingClients(): void {
    const now = this.nowMs();
    for (const [client, state] of this.clients) {
      if (now - state.lastPongAt >= this.clientTimeoutMs) {
        this.terminate(client);
        continue;
      }
      if (client.readyState !== WebSocket.OPEN) continue;
      try {
        client.ping();
      } catch {
        this.terminate(client);
      }
    }
  }

  private broadcastHeartbeat(): void {
    const heartbeat: ServerEvent = {
      type: "heartbeat",
      occurredAt: this.now()
    };
    for (const client of this.clients.keys()) this.send(client, heartbeat);
  }

  private invalidateSession(sessionId: string): void {
    for (const [client, state] of this.clients) {
      if (state.sessionId !== sessionId) continue;
      this.clients.delete(client);
      try {
        client.close(1008, "Session invalidated");
      } catch {
        this.terminate(client);
      }
    }
  }

  private terminate(client: WebSocket): void {
    this.clients.delete(client);
    try {
      client.terminate();
    } catch {
      // A failing client is isolated from the realtime gateway.
    }
  }

  private async stopOnce(): Promise<void> {
    const errors: unknown[] = [];
    const capture = (operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        errors.push(error);
      }
    };
    const server = this.attachedServer;
    this.attachedServer = undefined;
    if (server !== undefined) {
      capture(() => server.off("upgrade", this.handleUpgrade));
    }
    const unsubscribeJournal = this.unsubscribeJournal;
    this.unsubscribeJournal = undefined;
    if (unsubscribeJournal !== undefined) capture(unsubscribeJournal);
    const unsubscribeSessionInvalidation = this.unsubscribeSessionInvalidation;
    this.unsubscribeSessionInvalidation = undefined;
    if (unsubscribeSessionInvalidation !== undefined) {
      capture(unsubscribeSessionInvalidation);
    }
    if (this.heartbeatTimer !== undefined) {
      const heartbeatTimer = this.heartbeatTimer;
      this.heartbeatTimer = undefined;
      capture(() => this.scheduler.clearInterval(heartbeatTimer));
    }
    if (this.applicationHeartbeatTimer !== undefined) {
      const applicationHeartbeatTimer = this.applicationHeartbeatTimer;
      this.applicationHeartbeatTimer = undefined;
      capture(() => this.scheduler.clearInterval(applicationHeartbeatTimer));
    }
    for (const client of [...this.clients.keys()]) this.terminate(client);

    try {
      await new Promise<void>((resolve, reject) => {
        this.wss.close((error) =>
          error === undefined ? resolve() : reject(error)
        );
      });
    } catch (error) {
      errors.push(error);
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Realtime cleanup failed");
    }
  }
}
