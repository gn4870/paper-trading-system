import {
  SYMBOLS,
  type AccountSnapshot,
  type BootstrapResponse,
  type Order,
  type ServerEvent,
  type StockQuote,
  type Trade
} from "@paper/shared";
import { defineStore } from "pinia";
import { reactive, toRef } from "vue";

const RECENT_TRADE_LIMIT = 50;
const APPLIED_EVENT_LIMIT = 1_000;
const symbolOrder = new Map(SYMBOLS.map((symbol, index) => [symbol, index]));

const clone = <T>(value: T): T => structuredClone(value);
const compareQuotes = (left: StockQuote, right: StockQuote): number =>
  (symbolOrder.get(left.symbol) ?? Number.MAX_SAFE_INTEGER) -
    (symbolOrder.get(right.symbol) ?? Number.MAX_SAFE_INTEGER) ||
  left.symbol.localeCompare(right.symbol);
const compareOrders = (left: Order, right: Order): number =>
  right.sequence - left.sequence || left.id.localeCompare(right.id);
const compareTrades = (left: Trade, right: Trade): number =>
  right.sequence - left.sequence || left.id.localeCompare(right.id);

export interface TradingStore {
  account: AccountSnapshot | null;
  stocks: StockQuote[];
  orders: Order[];
  trades: Trade[];
  stateVersion: number;
  appliedEventIds: string[];
  replaceSnapshot(snapshot: BootstrapResponse): void;
  applyEvent(event: ServerEvent): void;
}

export const createTradingStoreHarness = (): TradingStore => {
  const quotesBySymbol = new Map<StockQuote["symbol"], StockQuote>();
  const ordersById = new Map<string, Order>();
  const tradesById = new Map<string, Trade>();
  const appliedEventIdSet = new Set<string>();

  const state = reactive<TradingStore>({
    account: null,
    stocks: [],
    orders: [],
    trades: [],
    stateVersion: 0,
    appliedEventIds: [],
    replaceSnapshot: (snapshot) => {
      quotesBySymbol.clear();
      ordersById.clear();
      tradesById.clear();
      appliedEventIdSet.clear();

      for (const quote of clone(snapshot.stocks))
        quotesBySymbol.set(quote.symbol, quote);
      for (const order of clone(snapshot.orders))
        ordersById.set(order.id, order);
      for (const trade of clone(snapshot.trades).sort(compareTrades)) {
        if (tradesById.size >= RECENT_TRADE_LIMIT) break;
        if (!tradesById.has(trade.id)) tradesById.set(trade.id, trade);
      }

      state.account = clone(snapshot.account);
      state.stocks = [...quotesBySymbol.values()].sort(compareQuotes);
      state.orders = [...ordersById.values()].sort(compareOrders);
      state.trades = [...tradesById.values()];
      state.stateVersion = snapshot.stateVersion;
      state.appliedEventIds = [];
    },
    applyEvent: (serverEvent) => {
      if (
        serverEvent.type === "connection.ready" ||
        serverEvent.type === "heartbeat"
      )
        return;
      if (
        serverEvent.stateVersion <= state.stateVersion ||
        appliedEventIdSet.has(serverEvent.eventId)
      ) {
        return;
      }

      switch (serverEvent.type) {
        case "market.updated": {
          const quote = clone(serverEvent.payload);
          quotesBySymbol.set(quote.symbol, quote);
          state.stocks = [...quotesBySymbol.values()].sort(compareQuotes);
          break;
        }
        case "order.updated": {
          const order = clone(serverEvent.payload);
          ordersById.set(order.id, order);
          state.orders = [...ordersById.values()].sort(compareOrders);
          break;
        }
        case "account.updated":
          state.account = clone(serverEvent.payload);
          break;
        case "trade.created": {
          const trade = clone(serverEvent.payload);
          tradesById.delete(trade.id);
          tradesById.set(trade.id, trade);
          const newest = [
            trade,
            ...[...tradesById.values()].filter(({ id }) => id !== trade.id)
          ].slice(0, RECENT_TRADE_LIMIT);
          tradesById.clear();
          for (const retained of newest) tradesById.set(retained.id, retained);
          state.trades = newest;
          break;
        }
      }

      state.stateVersion = serverEvent.stateVersion;
      appliedEventIdSet.add(serverEvent.eventId);
      state.appliedEventIds.push(serverEvent.eventId);
      if (state.appliedEventIds.length > APPLIED_EVENT_LIMIT) {
        const discarded = state.appliedEventIds.shift();
        if (discarded !== undefined) appliedEventIdSet.delete(discarded);
      }
    }
  });

  return state;
};

export const useTradingStore = defineStore("trading", () => {
  const harness = createTradingStoreHarness();
  return {
    account: toRef(harness, "account"),
    stocks: toRef(harness, "stocks"),
    orders: toRef(harness, "orders"),
    trades: toRef(harness, "trades"),
    stateVersion: toRef(harness, "stateVersion"),
    appliedEventIds: toRef(harness, "appliedEventIds"),
    replaceSnapshot: harness.replaceSnapshot,
    applyEvent: harness.applyEvent
  };
});
