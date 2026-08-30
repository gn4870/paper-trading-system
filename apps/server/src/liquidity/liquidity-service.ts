/**
 * 系统流动性服务。
 *
 * 两个内部系统账户围绕参考价各挂三档买卖单，让单用户演示也能成交。系统单
 * 仍复用普通下单、撮合和结算路径，不享有特殊价格或时间优先权。
 */
import {
  placeOrderSchema,
  type PlaceOrderRequest,
  type SymbolCode
} from "@paper/shared";

import { AccountLedger } from "../accounts/account-ledger.js";
import { DomainError } from "../infrastructure/domain-error.js";
import {
  MemoryState,
  type UserRecord
} from "../infrastructure/memory-state.js";
import { MarketSimulator } from "../market/market-simulator.js";
import { OrderService } from "../orders/order-service.js";

export const SYSTEM_MARKET_BUYER_ID = "system-market-buyer";
export const SYSTEM_MARKET_SELLER_ID = "system-market-seller";

const SYSTEM_CASH_MINOR = 8_500_000_000_000_000;
const SYSTEM_POSITION_QUANTITY = 1_000_000_000_000;
const LEVELS = [
  { distance: 0.001, quantity: 100 },
  { distance: 0.002, quantity: 200 },
  { distance: 0.003, quantity: 300 }
] as const;

const systemUser = (id: string): UserRecord => ({
  id,
  username: id,
  normalizedUsername: id,
  passwordDigest: "system-account",
  kind: "SYSTEM"
});

export interface UuidFactory {
  next(): string;
}

const defaultUuids: UuidFactory = {
  next: () => crypto.randomUUID()
};

interface PlannedOrder {
  userId: string;
  request: PlaceOrderRequest;
}

const safeProduct = (left: number, right: number): number => {
  const product = left * right;
  if (!Number.isSafeInteger(product)) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      500,
      "系统流动性金额超出安全整数范围"
    );
  }
  return product;
};

const safeSum = (left: number, right: number): number => {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      500,
      "系统流动性资产超出安全整数范围"
    );
  }
  return sum;
};

export class LiquidityService {
  private accountsInitialized = false;

  constructor(
    private readonly state: MemoryState,
    private readonly ledger: AccountLedger,
    private readonly orders: OrderService,
    private readonly market: MarketSimulator,
    private readonly uuids: UuidFactory = defaultUuids
  ) {}

  initializeAccounts(): void {
    if (this.accountsInitialized) return;

    this.state.users.set(
      SYSTEM_MARKET_BUYER_ID,
      systemUser(SYSTEM_MARKET_BUYER_ID)
    );
    this.state.users.set(
      SYSTEM_MARKET_SELLER_ID,
      systemUser(SYSTEM_MARKET_SELLER_ID)
    );
    this.ledger.seedSystemAccount(
      SYSTEM_MARKET_BUYER_ID,
      SYSTEM_CASH_MINOR,
      {}
    );
    this.ledger.seedSystemAccount(SYSTEM_MARKET_SELLER_ID, 0, {
      AAPL: SYSTEM_POSITION_QUANTITY,
      MSFT: SYSTEM_POSITION_QUANTITY,
      TSLA: SYSTEM_POSITION_QUANTITY
    });
    this.accountsInitialized = true;
  }

  refreshAll(): void {
    if (!this.accountsInitialized) {
      throw new Error("System liquidity accounts are not initialized");
    }

    // 先生成并校验完整计划，确认系统总资产足够后，才撤销上一周期的系统单。
    // 真实用户订单不在撤销范围内，会继续保留原 sequence 和时间优先级。
    const plan = this.buildRefreshPlan();
    this.assertRefreshAssets(plan);
    const activeSystemOrders = this.orders.listSystemOrders();

    for (const order of activeSystemOrders) {
      this.orders.cancel(order.userId, order.id);
    }

    for (const planned of plan) {
      this.orders.place(planned.userId, planned.request);
    }
    this.orders.reclaimTerminalSystemHistory();
  }

  private buildRefreshPlan(): PlannedOrder[] {
    const plan: PlannedOrder[] = [];
    const clientOrderIds = new Set<string>();
    for (const quote of this.market.snapshots()) {
      for (const level of LEVELS) {
        const bid = Math.max(
          1,
          Math.round(quote.lastPriceMinor * (1 - level.distance))
        );
        // 四舍五入可能让 bid/ask 相等，因此至少强制保留一个最小货币单位价差。
        const ask = Math.max(
          bid + 1,
          Math.round(quote.lastPriceMinor * (1 + level.distance))
        );
        plan.push(
          this.planLevel(
            SYSTEM_MARKET_BUYER_ID,
            quote.symbol,
            "BUY",
            bid,
            level.quantity,
            clientOrderIds
          )
        );
        plan.push(
          this.planLevel(
            SYSTEM_MARKET_SELLER_ID,
            quote.symbol,
            "SELL",
            ask,
            level.quantity,
            clientOrderIds
          )
        );
      }
    }
    return plan;
  }

  private planLevel(
    userId: string,
    symbol: SymbolCode,
    side: PlaceOrderRequest["side"],
    limitPriceMinor: number,
    quantity: number,
    clientOrderIds: Set<string>
  ): PlannedOrder {
    const clientOrderId = this.uuids.next();
    if (clientOrderIds.has(clientOrderId)) {
      throw new DomainError(
        "INVARIANT_VIOLATION",
        500,
        "系统流动性委托 ID 重复"
      );
    }
    clientOrderIds.add(clientOrderId);
    const request = placeOrderSchema.parse({
      clientOrderId,
      symbol,
      side,
      limitPriceMinor,
      quantity
    });
    safeProduct(request.limitPriceMinor, request.quantity);
    return { userId, request };
  }

  private assertRefreshAssets(plan: readonly PlannedOrder[]): void {
    let requiredCashMinor = 0;
    const requiredPositions: Record<SymbolCode, number> = {
      AAPL: 0,
      MSFT: 0,
      TSLA: 0
    };
    for (const planned of plan) {
      if (planned.request.side === "BUY") {
        requiredCashMinor = safeSum(
          requiredCashMinor,
          safeProduct(planned.request.limitPriceMinor, planned.request.quantity)
        );
      } else {
        requiredPositions[planned.request.symbol] = safeSum(
          requiredPositions[planned.request.symbol],
          planned.request.quantity
        );
      }
    }

    const buyer = this.ledger.snapshot(SYSTEM_MARKET_BUYER_ID);
    const releasableCashMinor = safeSum(
      buyer.cashAvailableMinor,
      buyer.cashFrozenMinor
    );
    if (releasableCashMinor < requiredCashMinor) {
      throw new DomainError("INSUFFICIENT_FUNDS", 409, "系统流动性资金不足");
    }

    const seller = this.ledger.snapshot(SYSTEM_MARKET_SELLER_ID);
    for (const symbol of ["AAPL", "MSFT", "TSLA"] as const) {
      const releasableQuantity = safeSum(
        seller.positions[symbol].availableQuantity,
        seller.positions[symbol].frozenQuantity
      );
      if (releasableQuantity < requiredPositions[symbol]) {
        throw new DomainError(
          "INSUFFICIENT_POSITION",
          409,
          `系统流动性 ${symbol} 持仓不足`
        );
      }
    }
  }
}
