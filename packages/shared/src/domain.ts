/**
 * 前后端共享的核心领域模型。
 *
 * 这里仅描述“系统中有什么数据”，不包含业务操作。服务端以这些类型保存
 * 内存状态，前端以相同类型渲染快照和实时事件，从而避免两端各自定义一套协议。
 * 金额统一使用最小货币单位（分），数量使用整数，避免浮点数参与结算。
 */
export const SYMBOLS = ["AAPL", "MSFT", "TSLA"] as const;

export type SymbolCode = (typeof SYMBOLS)[number];
export type OrderSide = "BUY" | "SELL";
export type OrderStatus = "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED";

export interface Order {
  id: string;
  clientOrderId: string;
  userId: string;
  symbol: SymbolCode;
  side: OrderSide;
  limitPriceMinor: number;
  originalQuantity: number;
  remainingQuantity: number;
  status: OrderStatus;
  /** 服务端严格递增序号；同价订单用它实现时间优先。 */
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface AccountSnapshot {
  userId: string;
  cashAvailableMinor: number;
  cashFrozenMinor: number;
  positions: Record<
    SymbolCode,
    {
      availableQuantity: number;
      frozenQuantity: number;
    }
  >;
}

export interface PricePoint {
  priceMinor: number;
  at: string;
}

export interface StockQuote {
  symbol: SymbolCode;
  name: string;
  openPriceMinor: number;
  lastPriceMinor: number;
  changePercent: number;
  bestBidMinor: number | null;
  bestAskMinor: number | null;
  /** 最近 60 个一秒行情点，仅用于轻量走势图，不是完整 K 线。 */
  history: PricePoint[];
}

export interface Trade {
  id: string;
  symbol: SymbolCode;
  buyOrderId: string;
  sellOrderId: string;
  buyerId: string;
  sellerId: string;
  priceMinor: number;
  quantity: number;
  executedAt: string;
  sequence: number;
}

export interface BootstrapResponse {
  user: { id: string; username: string };
  account: AccountSnapshot;
  stocks: StockQuote[];
  orders: Order[];
  trades: Trade[];
  /** 快照对应的全局事件版本，重连时据此丢弃已经包含在快照中的增量。 */
  stateVersion: number;
}
