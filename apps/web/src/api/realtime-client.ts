/**
 * WebSocket 传输客户端。
 *
 * 本类只处理连接、消息协议校验、存活检测和指数退避，不直接修改交易状态。
 * “快照 + 增量”的业务恢复由 realtime-store 负责，从而分离传输与状态归并。
 */
import { SYMBOLS, type ServerEvent } from "@paper/shared";

export interface RealtimeSocket {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(code?: number, reason?: string): void;
}

export type RealtimeSocketFactory = (url: string) => RealtimeSocket;

export interface RealtimeLocation {
  protocol: string;
  host: string;
}

export interface RealtimeTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RealtimeCloseInfo {
  event: CloseEvent | null;
  retryDelayMs: number | null;
}

export interface RealtimeTerminalCloseInfo {
  code: number;
  reason: string;
  error: Error;
}

export interface RealtimeClientOptions {
  socketFactory?: RealtimeSocketFactory;
  location?: RealtimeLocation;
  timer?: RealtimeTimer;
  random?: () => number;
  jitterRatio?: number;
  onOpen?: () => void;
  onMessage?: (event: ServerEvent) => void;
  onClose?: (info: RealtimeCloseInfo) => void;
  onProtocolError?: (error: Error) => void;
  onTerminalError?: (info: RealtimeTerminalCloseInfo) => void;
}

const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 10_000;
const LIVENESS_TIMEOUT_MS = 10_000;
const CLIENT_RETRY_CLOSE_CODE = 4_000;
const DEFAULT_JITTER_RATIO = 0.2;
const terminalCloseCodes = new Set([1008, 4001, 4401]);
const defaultTimer: RealtimeTimer = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isString = (value: unknown): value is string => typeof value === "string";
const isNonEmptyString = (value: unknown): value is string =>
  isString(value) && value.trim().length > 0;
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);
const isNonNegativeInteger = (value: unknown): value is number =>
  isSafeInteger(value) && value >= 0;
const isPositiveInteger = (value: unknown): value is number =>
  isSafeInteger(value) && value > 0;
const isNullablePositiveInteger = (value: unknown): value is number | null =>
  value === null || isPositiveInteger(value);
const isSymbol = (value: unknown): boolean =>
  isString(value) && (SYMBOLS as readonly string[]).includes(value);

const hasBusinessMetadata = (value: Record<string, unknown>): boolean =>
  isNonEmptyString(value.eventId) &&
  isPositiveInteger(value.stateVersion) &&
  isNonEmptyString(value.occurredAt);

const isPricePoint = (value: unknown): boolean =>
  isRecord(value) &&
  isPositiveInteger(value.priceMinor) &&
  isNonEmptyString(value.at);
const isQuote = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !isSymbol(value.symbol) ||
    !isNonEmptyString(value.name) ||
    !isPositiveInteger(value.openPriceMinor) ||
    !isPositiveInteger(value.lastPriceMinor) ||
    !isFiniteNumber(value.changePercent) ||
    !isNullablePositiveInteger(value.bestBidMinor) ||
    !isNullablePositiveInteger(value.bestAskMinor) ||
    !Array.isArray(value.history) ||
    value.history.length > 60 ||
    !value.history.every(isPricePoint)
  ) {
    return false;
  }
  return (
    value.bestBidMinor === null ||
    value.bestAskMinor === null ||
    value.bestBidMinor <= value.bestAskMinor
  );
};
const isOrder = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.clientOrderId) ||
    !isNonEmptyString(value.userId) ||
    !isSymbol(value.symbol) ||
    (value.side !== "BUY" && value.side !== "SELL") ||
    !isPositiveInteger(value.limitPriceMinor) ||
    !isPositiveInteger(value.originalQuantity) ||
    !isNonNegativeInteger(value.remainingQuantity) ||
    value.remainingQuantity > value.originalQuantity ||
    !isPositiveInteger(value.sequence) ||
    !isNonEmptyString(value.createdAt) ||
    !isNonEmptyString(value.updatedAt)
  ) {
    return false;
  }
  switch (value.status) {
    case "OPEN":
      return value.remainingQuantity === value.originalQuantity;
    case "PARTIALLY_FILLED":
      return (
        value.remainingQuantity > 0 &&
        value.remainingQuantity < value.originalQuantity
      );
    case "FILLED":
      return value.remainingQuantity === 0;
    case "CANCELED":
      return value.remainingQuantity > 0;
    default:
      return false;
  }
};
const isPosition = (value: unknown): boolean =>
  isRecord(value) &&
  isNonNegativeInteger(value.availableQuantity) &&
  isNonNegativeInteger(value.frozenQuantity);
const isAccount = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.userId) ||
    !isNonNegativeInteger(value.cashAvailableMinor) ||
    !isNonNegativeInteger(value.cashFrozenMinor) ||
    !isRecord(value.positions)
  ) {
    return false;
  }
  const positions = value.positions;
  return (
    Object.keys(positions).length === SYMBOLS.length &&
    SYMBOLS.every((symbol) => isPosition(positions[symbol]))
  );
};
const isTrade = (value: unknown): boolean =>
  isRecord(value) &&
  isNonEmptyString(value.id) &&
  isSymbol(value.symbol) &&
  isNonEmptyString(value.buyOrderId) &&
  isNonEmptyString(value.sellOrderId) &&
  isNonEmptyString(value.buyerId) &&
  isNonEmptyString(value.sellerId) &&
  isPositiveInteger(value.priceMinor) &&
  isPositiveInteger(value.quantity) &&
  isNonEmptyString(value.executedAt) &&
  isPositiveInteger(value.sequence);

type ParseResult =
  | { kind: "event"; event: ServerEvent }
  | { kind: "invalid"; type: string }
  | { kind: "unknown" };

const knownEventTypes = new Set([
  "heartbeat",
  "connection.ready",
  "market.updated",
  "order.updated",
  "account.updated",
  "trade.created"
]);

const parseServerEvent = (raw: unknown): ParseResult => {
  // WebSocket 数据来自网络，不能仅靠 TypeScript 类型断言；已知事件必须逐字段
  // 验证，未知的未来事件则忽略，以保留协议向前兼容空间。
  if (typeof raw !== "string") return { kind: "unknown" };
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { kind: "unknown" };
  }
  if (!isRecord(value) || !isString(value.type)) return { kind: "unknown" };
  if (!knownEventTypes.has(value.type)) return { kind: "unknown" };
  if (value.type === "heartbeat") {
    return isNonEmptyString(value.occurredAt)
      ? { kind: "event", event: value as unknown as ServerEvent }
      : { kind: "invalid", type: value.type };
  }
  if (value.type === "connection.ready") {
    return isNonNegativeInteger(value.stateVersion) &&
      isNonEmptyString(value.occurredAt)
      ? { kind: "event", event: value as unknown as ServerEvent }
      : { kind: "invalid", type: value.type };
  }
  if (!hasBusinessMetadata(value)) return { kind: "invalid", type: value.type };
  const validPayload =
    (value.type === "market.updated" && isQuote(value.payload)) ||
    (value.type === "order.updated" && isOrder(value.payload)) ||
    (value.type === "account.updated" && isAccount(value.payload)) ||
    (value.type === "trade.created" && isTrade(value.payload));
  return validPayload
    ? { kind: "event", event: value as unknown as ServerEvent }
    : { kind: "invalid", type: value.type };
};

export class RealtimeClient {
  private readonly socketFactory: RealtimeSocketFactory;
  private readonly location: RealtimeLocation;
  private readonly timer: RealtimeTimer;
  private readonly random: () => number;
  private readonly jitterRatio: number;
  private readonly onOpen: () => void;
  private readonly onMessage: (event: ServerEvent) => void;
  private readonly onClose: (info: RealtimeCloseInfo) => void;
  private readonly onProtocolError: (error: Error) => void;
  private readonly onTerminalError: (info: RealtimeTerminalCloseInfo) => void;
  private socket: RealtimeSocket | undefined;
  private retryTimer: unknown | undefined;
  private livenessTimer: unknown | undefined;
  private retryAttempt = 0;
  // 每次换 socket 都推进 generation，旧连接迟到的回调不会污染当前连接。
  private generation = 0;
  private active = false;

  constructor(options: RealtimeClientOptions = {}) {
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.location = options.location ?? globalThis.location;
    this.timer = options.timer ?? defaultTimer;
    this.random = options.random ?? Math.random;
    this.jitterRatio = Math.max(0, options.jitterRatio ?? DEFAULT_JITTER_RATIO);
    this.onOpen = options.onOpen ?? (() => undefined);
    this.onMessage = options.onMessage ?? (() => undefined);
    this.onClose = options.onClose ?? (() => undefined);
    this.onProtocolError = options.onProtocolError ?? (() => undefined);
    this.onTerminalError = options.onTerminalError ?? (() => undefined);
  }

  connect(): void {
    if (this.active) return;
    this.active = true;
    this.retryAttempt = 0;
    this.openSocket();
  }

  disconnect(): void {
    this.active = false;
    this.retryAttempt = 0;
    this.clearRetryTimer();
    this.clearLivenessTimer();
    this.generation += 1;
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "client disconnect");
    }
  }

  retry(): void {
    if (!this.active) return;
    if (this.retryTimer !== undefined) return;
    const socket = this.socket;
    // 同步层发现冲突时主动关闭当前连接，统一进入正常的退避重连流程。
    if (socket !== undefined && socket.readyState < WebSocket.CLOSING) {
      socket.close(CLIENT_RETRY_CLOSE_CODE, "resynchronization failed");
      return;
    }
    if (socket === undefined) this.scheduleRetry(null);
  }

  markSynchronized(): void {
    // 仅“连接成功”还不够；直到 bootstrap 与缓冲事件归并完成才重置退避次数。
    this.retryAttempt = 0;
  }

  private openSocket(): void {
    if (!this.active || this.socket !== undefined) return;
    const generation = ++this.generation;
    let socket: RealtimeSocket;
    try {
      socket = this.socketFactory(this.websocketUrl());
    } catch {
      this.scheduleRetry(null);
      return;
    }
    this.socket = socket;
    const isCurrent = (): boolean =>
      this.active && this.generation === generation && this.socket === socket;

    socket.onopen = () => {
      if (!isCurrent()) return;
      this.armLivenessTimer(socket, generation);
      this.onOpen();
    };
    socket.onmessage = (message) => {
      if (!isCurrent()) return;
      const parsed = parseServerEvent(message.data);
      if (parsed.kind === "event") {
        this.armLivenessTimer(socket, generation);
        this.onMessage(parsed.event);
      } else if (parsed.kind === "invalid") {
        this.onProtocolError(
          new Error(`Invalid ${parsed.type} WebSocket event`)
        );
      }
    };
    socket.onclose = (closeEvent) => {
      if (!isCurrent()) return;
      this.socket = undefined;
      this.clearLivenessTimer();
      if (terminalCloseCodes.has(closeEvent.code)) {
        this.active = false;
        this.onTerminalError({
          code: closeEvent.code,
          reason: closeEvent.reason,
          error: new Error(`WebSocket session rejected (${closeEvent.code})`)
        });
        return;
      }
      this.scheduleRetry(closeEvent);
    };
    socket.onerror = () => {
      if (isCurrent() && socket.readyState < WebSocket.CLOSING) {
        this.abandonSocket(socket, generation, "websocket error");
      }
    };
  }

  private scheduleRetry(event: CloseEvent | null): void {
    if (!this.active || this.retryTimer !== undefined) return;
    // 500ms 起步、指数增长、10s 封顶，并加入抖动避免大量客户端同时重连。
    const exponent = Math.min(this.retryAttempt, 30);
    const baseDelay = Math.min(
      MAX_RETRY_DELAY_MS,
      BASE_RETRY_DELAY_MS * 2 ** exponent
    );
    this.retryAttempt += 1;
    const boundedRandom = Math.min(1, Math.max(0, this.random()));
    const jitterFactor = 1 + (boundedRandom * 2 - 1) * this.jitterRatio;
    const retryDelayMs = Math.min(
      MAX_RETRY_DELAY_MS,
      Math.max(0, Math.round(baseDelay * jitterFactor))
    );
    this.onClose({ event, retryDelayMs });
    this.retryTimer = this.timer.setTimeout(() => {
      this.retryTimer = undefined;
      this.openSocket();
    }, retryDelayMs);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === undefined) return;
    this.timer.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private armLivenessTimer(socket: RealtimeSocket, generation: number): void {
    // 浏览器拿不到原生 ping/pong 控制帧，因此以任意合法服务端消息（包含应用层
    // heartbeat）刷新存活计时器。
    this.clearLivenessTimer();
    this.livenessTimer = this.timer.setTimeout(() => {
      this.livenessTimer = undefined;
      if (
        !this.active ||
        this.generation !== generation ||
        this.socket !== socket
      ) {
        return;
      }
      this.abandonSocket(socket, generation, "liveness timeout");
    }, LIVENESS_TIMEOUT_MS);
  }

  private abandonSocket(
    socket: RealtimeSocket,
    generation: number,
    reason: string
  ): void {
    if (
      !this.active ||
      this.generation !== generation ||
      this.socket !== socket
    ) {
      return;
    }
    // 先让旧 socket 失效，再安排独立重试；即使 close 抛错也不会卡住恢复。
    this.generation += 1;
    this.socket = undefined;
    this.clearLivenessTimer();
    if (socket.readyState < WebSocket.CLOSING) {
      try {
        socket.close(CLIENT_RETRY_CLOSE_CODE, reason);
      } catch {
        // The stale transport must not prevent an independent retry.
      }
    }
    this.scheduleRetry(null);
  }

  private clearLivenessTimer(): void {
    if (this.livenessTimer === undefined) return;
    this.timer.clearTimeout(this.livenessTimer);
    this.livenessTimer = undefined;
  }

  private websocketUrl(): string {
    const protocol = this.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${this.location.host}/ws`;
  }
}
