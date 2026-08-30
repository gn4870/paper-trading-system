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
