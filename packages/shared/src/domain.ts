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
  stateVersion: number;
}
