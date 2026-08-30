import {
  SYMBOLS,
  type Order,
  type PlaceOrderRequest,
  type SymbolCode,
  type Trade
} from "@paper/shared";

import { AccountLedger } from "../accounts/account-ledger.js";
import { DomainError } from "../infrastructure/domain-error.js";
import {
  type Clock,
  EventJournal,
  type EventDraft,
  type IdGenerator
} from "../infrastructure/event-journal.js";
import {
  type IdempotencyRecord,
  MemoryState
} from "../infrastructure/memory-state.js";
import { OrderBook, type SubmitResult } from "../matching/order-book.js";

export interface PlaceOrderResult {
  order: Order;
  trades: Trade[];
  replayed: boolean;
}

export interface CancelOrderResult {
  order: Order;
}

interface CommandStateSnapshot {
  orders: Map<string, Order>;
  trades: Trade[];
  idempotency: Map<string, IdempotencyRecord>;
  books: Map<SymbolCode, OrderBook>;
  nextOrderSequence: number;
  nextTradeSequence: number;
}

const clone = <T>(value: T): T => structuredClone(value);
const isActive = (order: Order): boolean =>
  order.remainingQuantity > 0 &&
  (order.status === "OPEN" || order.status === "PARTIALLY_FILLED");

export class OrderService {
  constructor(
    private readonly state: MemoryState,
    private readonly ledger: AccountLedger,
    private readonly journal: EventJournal,
    private readonly clock: Clock,
    private readonly ids: IdGenerator
  ) {
    for (const symbol of SYMBOLS) {
      if (!state.books.has(symbol)) {
        state.books.set(symbol, this.emptyBook(symbol));
      }
    }
  }

  place(userId: string, request: PlaceOrderRequest): PlaceOrderResult {
    const idempotencyKey = `${userId}:${request.clientOrderId}`;
    const existingRecord = this.state.idempotency.get(idempotencyKey);
    if (existingRecord !== undefined) {
      const existing = this.requireOrder(existingRecord.orderId);
      return {
        order: clone(existing),
        trades: clone(existingRecord.trades),
        replayed: true
      };
    }

    return this.runCommand(() => {
      this.ledger.reserve({
        userId,
        side: request.side,
        symbol: request.symbol,
        limitPriceMinor: request.limitPriceMinor,
        quantity: request.quantity
      });

      const now = this.clock.now();
      const order: Order = {
        id: this.ids.next(),
        clientOrderId: request.clientOrderId,
        userId,
        symbol: request.symbol,
        side: request.side,
        limitPriceMinor: request.limitPriceMinor,
        originalQuantity: request.quantity,
        remainingQuantity: request.quantity,
        status: "OPEN",
        sequence: this.state.nextOrderSequence++,
        createdAt: now,
        updatedAt: now
      };
      this.state.orders.set(order.id, clone(order));

      const book = this.buildBook(request.symbol, order.id);
      const matched = book.submit(order);
      const trades = this.settleFills(matched, now);

      if (
        matched.selfTradePrevented &&
        matched.incoming.remainingQuantity > 0
      ) {
        this.ledger.release({
          userId,
          side: matched.incoming.side,
          symbol: matched.incoming.symbol,
          limitPriceMinor: matched.incoming.limitPriceMinor,
          quantity: matched.incoming.remainingQuantity
        });
      }

      this.persistMatchedOrders(matched, now);
      this.state.books.set(request.symbol, book);
      this.state.idempotency.set(idempotencyKey, {
        orderId: order.id,
        trades: clone(trades)
      });
      this.journal.publish(this.placeEventDrafts(matched, trades));

      return {
        order: clone(this.requireOrder(order.id)),
        trades: clone(trades),
        replayed: false
      };
    });
  }

  cancel(userId: string, orderId: string): CancelOrderResult {
    const found = this.state.orders.get(orderId);
    if (found === undefined || found.userId !== userId) {
      throw new DomainError("ORDER_NOT_FOUND", 404, "订单不存在");
    }
    if (!isActive(found)) {
      throw new DomainError("ORDER_NOT_ACTIVE", 409, "订单不可撤销");
    }

    return this.runCommand(() => {
      const order = this.requireOrder(orderId);
      const book = this.buildBook(order.symbol);
      if (book.remove(order.id) === undefined) {
        throw new DomainError("INVARIANT_VIOLATION", 500, "订单状态不合法");
      }
      this.state.books.set(order.symbol, book);

      const canceled: Order = {
        ...order,
        status: "CANCELED",
        updatedAt: this.clock.now()
      };
      this.state.orders.set(canceled.id, clone(canceled));
      this.ledger.release({
        userId,
        side: canceled.side,
        symbol: canceled.symbol,
        limitPriceMinor: canceled.limitPriceMinor,
        quantity: canceled.remainingQuantity
      });

      this.journal.publish([
        {
          type: "order.updated",
          audience: { kind: "user", userId },
          payload: clone(canceled)
        },
        {
          type: "account.updated",
          audience: { kind: "user", userId },
          payload: this.ledger.snapshot(userId)
        }
      ]);
      return { order: clone(canceled) };
    });
  }

  listForUser(userId: string): Order[] {
    return [...this.state.orders.values()]
      .filter((order) => order.userId === userId)
      .sort((left, right) => right.sequence - left.sequence)
      .map(clone);
  }

  listSystemOrders(symbol?: SymbolCode): Order[] {
    return [...this.state.orders.values()]
      .filter(
        (order) =>
          isActive(order) &&
          this.isSystemUser(order.userId) &&
          (symbol === undefined || order.symbol === symbol)
      )
      .sort((left, right) => left.sequence - right.sequence)
      .map(clone);
  }

  recentTradesForUser(userId: string): Trade[] {
    return this.state.trades
      .filter((trade) => trade.buyerId === userId || trade.sellerId === userId)
      .slice(-50)
      .reverse()
      .map(clone);
  }

  reclaimTerminalSystemHistory(): void {
    const reclaimedOrderIds = new Set<string>();
    for (const [orderId, order] of this.state.orders) {
      if (!isActive(order) && this.isSystemUser(order.userId)) {
        reclaimedOrderIds.add(orderId);
        this.state.orders.delete(orderId);
      }
    }
    if (reclaimedOrderIds.size === 0) return;
    for (const [key, record] of this.state.idempotency) {
      if (reclaimedOrderIds.has(record.orderId)) {
        this.state.idempotency.delete(key);
      }
    }
  }

  private settleFills(matched: SubmitResult, executedAt: string): Trade[] {
    const trades: Trade[] = [];
    for (const fill of matched.fills) {
      this.ledger.settle({
        buyerId: fill.buyOrder.userId,
        sellerId: fill.sellOrder.userId,
        symbol: fill.buyOrder.symbol,
        buyLimitPriceMinor: fill.buyOrder.limitPriceMinor,
        executionPriceMinor: fill.executionPriceMinor,
        quantity: fill.quantity
      });
      const trade: Trade = {
        id: this.ids.next(),
        symbol: fill.buyOrder.symbol,
        buyOrderId: fill.buyOrder.id,
        sellOrderId: fill.sellOrder.id,
        buyerId: fill.buyOrder.userId,
        sellerId: fill.sellOrder.userId,
        priceMinor: fill.executionPriceMinor,
        quantity: fill.quantity,
        executedAt,
        sequence: this.state.nextTradeSequence++
      };
      trades.push(trade);
      this.state.trades.push(clone(trade));
      if (this.state.trades.length > 1_000) {
        this.state.trades.splice(0, this.state.trades.length - 1_000);
      }
    }
    return trades;
  }

  private persistMatchedOrders(matched: SubmitResult, updatedAt: string): void {
    for (const fill of matched.fills) {
      this.state.orders.set(fill.buyOrder.id, { ...fill.buyOrder, updatedAt });
      this.state.orders.set(fill.sellOrder.id, {
        ...fill.sellOrder,
        updatedAt
      });
    }
    this.state.orders.set(matched.incoming.id, {
      ...matched.incoming,
      updatedAt
    });
  }

  private placeEventDrafts(
    matched: SubmitResult,
    trades: readonly Trade[]
  ): EventDraft[] {
    const drafts: EventDraft[] = [];
    const orderIds = new Set<string>([matched.incoming.id]);
    const userIds = new Set<string>([matched.incoming.userId]);
    for (const fill of matched.fills) {
      orderIds.add(fill.buyOrder.id);
      orderIds.add(fill.sellOrder.id);
      userIds.add(fill.buyOrder.userId);
      userIds.add(fill.sellOrder.userId);
    }

    for (const orderId of orderIds) {
      const order = this.requireOrder(orderId);
      drafts.push({
        type: "order.updated",
        audience: { kind: "user", userId: order.userId },
        payload: clone(order)
      });
    }
    for (const userId of userIds) {
      drafts.push({
        type: "account.updated",
        audience: { kind: "user", userId },
        payload: this.ledger.snapshot(userId)
      });
    }
    for (const trade of trades) {
      drafts.push({
        type: "trade.created",
        audience: { kind: "user", userId: trade.buyerId },
        payload: clone(trade)
      });
      if (trade.sellerId !== trade.buyerId) {
        drafts.push({
          type: "trade.created",
          audience: { kind: "user", userId: trade.sellerId },
          payload: clone(trade)
        });
      }
    }
    return drafts;
  }

  private buildBook(symbol: SymbolCode, excludedOrderId?: string): OrderBook {
    const book = this.emptyBook(symbol);
    const activeOrders = [...this.state.orders.values()]
      .filter(
        (order) =>
          order.symbol === symbol &&
          order.id !== excludedOrderId &&
          isActive(order)
      )
      .sort((left, right) => left.sequence - right.sequence);
    for (const order of activeOrders) {
      book.submit(clone(order));
    }
    return book;
  }

  private emptyBook(symbol: SymbolCode): OrderBook {
    return new OrderBook(symbol, (userId) => this.isSystemUser(userId));
  }

  private isSystemUser(userId: string): boolean {
    return this.state.users.get(userId)?.kind === "SYSTEM";
  }

  private requireOrder(orderId: string): Order {
    const order = this.state.orders.get(orderId);
    if (order === undefined) {
      throw new DomainError("ORDER_NOT_FOUND", 404, "订单不存在");
    }
    return clone(order);
  }

  private runCommand<T>(operation: () => T): T {
    const before = this.snapshotCommandState();
    return this.ledger.transact(() => {
      try {
        return operation();
      } catch (error) {
        this.restoreCommandState(before);
        throw error;
      }
    });
  }

  private snapshotCommandState(): CommandStateSnapshot {
    return {
      orders: new Map(
        [...this.state.orders].map(([orderId, order]) => [
          orderId,
          clone(order)
        ])
      ),
      trades: this.state.trades.map(clone),
      idempotency: new Map(
        [...this.state.idempotency].map(([key, record]) => [key, clone(record)])
      ),
      books: new Map(this.state.books),
      nextOrderSequence: this.state.nextOrderSequence,
      nextTradeSequence: this.state.nextTradeSequence
    };
  }

  private restoreCommandState(before: CommandStateSnapshot): void {
    this.state.orders.clear();
    for (const [orderId, order] of before.orders) {
      this.state.orders.set(orderId, clone(order));
    }
    this.state.trades.splice(
      0,
      this.state.trades.length,
      ...before.trades.map(clone)
    );
    this.state.idempotency.clear();
    for (const [key, record] of before.idempotency) {
      this.state.idempotency.set(key, clone(record));
    }
    this.state.books.clear();
    for (const [symbol, book] of before.books) {
      this.state.books.set(symbol, book);
    }
    this.state.nextOrderSequence = before.nextOrderSequence;
    this.state.nextTradeSequence = before.nextTradeSequence;
  }
}
