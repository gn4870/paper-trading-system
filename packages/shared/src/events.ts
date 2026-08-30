/**
 * WebSocket 事件协议。
 *
 * 业务事件都带 eventId 与单调递增的 stateVersion。前端可用 eventId 去重，
 * 用 stateVersion 判断事件是否已经包含在 bootstrap 快照中。heartbeat 和
 * connection.ready 属于连接控制消息，不直接修改交易状态。
 */
import type { AccountSnapshot, Order, StockQuote, Trade } from "./domain.js";

export interface EventMetadata {
  eventId: string;
  stateVersion: number;
  occurredAt: string;
}

export interface ConnectionReadyEvent {
  type: "connection.ready";
  stateVersion: number;
  occurredAt: string;
}

export interface MarketUpdatedEvent extends EventMetadata {
  type: "market.updated";
  payload: StockQuote;
}

export interface OrderUpdatedEvent extends EventMetadata {
  type: "order.updated";
  payload: Order;
}

export interface AccountUpdatedEvent extends EventMetadata {
  type: "account.updated";
  payload: AccountSnapshot;
}

export interface TradeCreatedEvent extends EventMetadata {
  type: "trade.created";
  payload: Trade;
}

export interface HeartbeatEvent {
  type: "heartbeat";
  occurredAt: string;
}

export type BusinessServerEvent =
  | MarketUpdatedEvent
  | OrderUpdatedEvent
  | AccountUpdatedEvent
  | TradeCreatedEvent;

export type ServerEvent =
  ConnectionReadyEvent | BusinessServerEvent | HeartbeatEvent;
