/**
 * 单个 Node.js 进程内的共享状态容器。
 *
 * 题目明确不要求持久化，因此这里用 Map/数组代替数据库；服务重启后全部清空。
 * 账户余额没有放在此类的公共字段中，而由 AccountLedger 私有持有，避免其他
 * 模块绕过冻结、释放和结算规则直接修改资产。
 */
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
  /** 首次成功处理的订单及其完整成交结果，供网络不确定后的重复请求回放。 */
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
  /** sequence 与时间戳分离，避免同一毫秒内订单无法稳定排序。 */
  nextOrderSequence = 1;
  nextTradeSequence = 1;
}
