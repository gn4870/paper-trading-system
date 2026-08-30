import type { Order, OrderSide, SymbolCode } from "@paper/shared";

import { DomainError } from "../infrastructure/domain-error.js";

export type IsSystemUser = (userId: string) => boolean;

export interface Fill {
  buyOrder: Order;
  sellOrder: Order;
  executionPriceMinor: number;
  quantity: number;
}

export interface SubmitResult {
  incoming: Order;
  fills: Fill[];
  selfTradePrevented: boolean;
}

export interface TopOfBook {
  bestBidMinor: number | null;
  bestAskMinor: number | null;
}

const invariant = (): never => {
  throw new DomainError("INVARIANT_VIOLATION", 500, "订单状态不合法");
};

const cloneOrder = (order: Order): Order => ({ ...order });

const isTerminal = (status: Order["status"]): boolean =>
  status === "FILLED" || status === "CANCELED";

function applyFilledQuantity(order: Order, quantity: number): void {
  if (
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    quantity > order.remainingQuantity
  ) {
    invariant();
  }
  order.remainingQuantity -= quantity;
  order.status = order.remainingQuantity === 0 ? "FILLED" : "PARTIALLY_FILLED";
}

const compareBuyOrders = (left: Order, right: Order): number =>
  right.limitPriceMinor - left.limitPriceMinor ||
  left.sequence - right.sequence;

const compareSellOrders = (left: Order, right: Order): number =>
  left.limitPriceMinor - right.limitPriceMinor ||
  left.sequence - right.sequence;

const isOrderSide = (value: unknown): value is OrderSide =>
  value === "BUY" || value === "SELL";

export class OrderBook {
  private readonly buys: Order[] = [];
  private readonly sells: Order[] = [];
  private readonly acceptedOrderIds = new Set<string>();

  constructor(
    private readonly symbol: SymbolCode,
    private readonly isSystemUser: IsSystemUser = () => false
  ) {}

  submit(order: Order): SubmitResult {
    this.assertSubmitOrder(order);
    if (this.acceptedOrderIds.has(order.id)) {
      invariant();
    }
    this.acceptedOrderIds.add(order.id);

    const incoming = cloneOrder(order);
    const fills: Fill[] = [];
    let selfTradePrevented = false;

    while (incoming.remainingQuantity > 0) {
      const resting = this.bestOppositeOrder(incoming.side);
      if (resting === undefined || !this.crosses(incoming, resting)) {
        break;
      }

      if (
        resting.userId === incoming.userId &&
        !this.isSystemUser(incoming.userId)
      ) {
        incoming.status = "CANCELED";
        selfTradePrevented = true;
        break;
      }

      const quantity = Math.min(
        incoming.remainingQuantity,
        resting.remainingQuantity
      );
      applyFilledQuantity(incoming, quantity);
      applyFilledQuantity(resting, quantity);
      fills.push(this.fillFor(incoming, resting, quantity));

      if (resting.status === "FILLED") {
        this.removeInternal(resting.id);
      }
    }

    if (incoming.remainingQuantity > 0 && incoming.status !== "CANCELED") {
      this.rest(incoming);
    }

    return {
      incoming: cloneOrder(incoming),
      fills,
      selfTradePrevented
    };
  }

  remove(orderId: string): Order | undefined {
    const removed = this.removeInternal(orderId);
    return removed === undefined ? undefined : cloneOrder(removed);
  }

  get(orderId: string): Order | undefined {
    const order =
      this.buys.find((candidate) => candidate.id === orderId) ??
      this.sells.find((candidate) => candidate.id === orderId);
    return order === undefined ? undefined : cloneOrder(order);
  }

  ordersForUser(userId: string): Order[] {
    return [...this.buys, ...this.sells]
      .filter((order) => order.userId === userId)
      .sort((left, right) => left.sequence - right.sequence)
      .map(cloneOrder);
  }

  topOfBook(): TopOfBook {
    return {
      bestBidMinor: this.buys[0]?.limitPriceMinor ?? null,
      bestAskMinor: this.sells[0]?.limitPriceMinor ?? null
    };
  }

  private assertSubmitOrder(order: Order): void {
    if (
      order.symbol !== this.symbol ||
      !isOrderSide(order.side) ||
      isTerminal(order.status) ||
      !Number.isSafeInteger(order.limitPriceMinor) ||
      order.limitPriceMinor <= 0 ||
      !Number.isSafeInteger(order.originalQuantity) ||
      order.originalQuantity <= 0 ||
      !Number.isSafeInteger(order.remainingQuantity) ||
      order.remainingQuantity <= 0 ||
      order.remainingQuantity > order.originalQuantity ||
      !Number.isSafeInteger(order.sequence) ||
      order.sequence < 0
    ) {
      invariant();
    }
  }

  private bestOppositeOrder(side: OrderSide): Order | undefined {
    return side === "BUY" ? this.sells[0] : this.buys[0];
  }

  private crosses(incoming: Order, resting: Order): boolean {
    return incoming.side === "BUY"
      ? incoming.limitPriceMinor >= resting.limitPriceMinor
      : incoming.limitPriceMinor <= resting.limitPriceMinor;
  }

  private fillFor(incoming: Order, resting: Order, quantity: number): Fill {
    const buyOrder = incoming.side === "BUY" ? incoming : resting;
    const sellOrder = incoming.side === "SELL" ? incoming : resting;
    return {
      buyOrder: cloneOrder(buyOrder),
      sellOrder: cloneOrder(sellOrder),
      executionPriceMinor: resting.limitPriceMinor,
      quantity
    };
  }

  private rest(order: Order): void {
    const side = order.side === "BUY" ? this.buys : this.sells;
    side.push(order);
    side.sort(order.side === "BUY" ? compareBuyOrders : compareSellOrders);
  }

  private removeInternal(orderId: string): Order | undefined {
    const collections = [this.buys, this.sells];
    for (const side of collections) {
      const index = side.findIndex((order) => order.id === orderId);
      if (index >= 0) {
        return side.splice(index, 1)[0];
      }
    }
    return undefined;
  }
}
