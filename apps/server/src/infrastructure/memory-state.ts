import type { Order, StockQuote, SymbolCode, Trade } from "@paper/shared";

import type { OrderBook } from "../matching/order-book.js";

export interface UserRecord {
  id: string;
  username: string;
  normalizedUsername: string;
  passwordDigest: string;
  kind: "REAL" | "SYSTEM";
}

export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: string;
}

export interface IdempotencyRecord {
  orderId: string;
  trades: Trade[];
}

/**
 * Shared in-memory state scope. Account storage intentionally remains owned by
 * AccountLedger so normal state consumers cannot mutate account balances.
 */
export class MemoryState {
  readonly users = new Map<string, UserRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly orders = new Map<string, Order>();
  readonly trades: Trade[] = [];
  readonly idempotency = new Map<string, IdempotencyRecord>();
  readonly books = new Map<SymbolCode, OrderBook>();
  readonly quotes = new Map<SymbolCode, StockQuote>();
  nextOrderSequence = 1;
  nextTradeSequence = 1;
}
