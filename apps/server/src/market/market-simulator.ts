/**
 * 三支股票的参考行情模拟器。
 *
 * 参考价每秒随机波动 -0.5%～+0.5%，与订单簿真实成交价是两个不同概念；
 * 订单簿的最佳买卖价会在流动性刷新后再写回行情快照。
 */
import { SYMBOLS, type StockQuote, type SymbolCode } from "@paper/shared";

import {
  type Clock,
  EventJournal,
  type EventDraft
} from "../infrastructure/event-journal.js";
import { MemoryState } from "../infrastructure/memory-state.js";

export interface RandomSource {
  next(): number;
}

interface StockDefinition {
  name: string;
  openPriceMinor: number;
}

const STOCKS: Record<SymbolCode, StockDefinition> = {
  AAPL: { name: "Apple", openPriceMinor: 18_700 },
  MSFT: { name: "Microsoft", openPriceMinor: 42_600 },
  TSLA: { name: "Tesla", openPriceMinor: 24_400 }
};

const clone = <T>(value: T): T => structuredClone(value);

export class MarketSimulator {
  constructor(
    private readonly state: MemoryState,
    private readonly journal: EventJournal,
    private readonly clock: Clock,
    private readonly random: RandomSource
  ) {}

  initialize(): void {
    for (const symbol of SYMBOLS) {
      const definition = STOCKS[symbol];
      const quote: StockQuote = {
        symbol,
        name: definition.name,
        openPriceMinor: definition.openPriceMinor,
        lastPriceMinor: definition.openPriceMinor,
        changePercent: 0,
        bestBidMinor: null,
        bestAskMinor: null,
        history: [
          { priceMinor: definition.openPriceMinor, at: this.clock.now() }
        ]
      };
      this.state.quotes.set(symbol, quote);
    }
  }

  advanceAll(): void {
    // 先在局部数组中计算完三支股票，再一次性写回 Map。任意一支计算失败时，
    // 不会出现只有部分股票进入新周期的状态。
    const nextQuotes = SYMBOLS.map((symbol) => {
      const previous = this.requireQuote(symbol);
      const randomValue = this.random.next();
      if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
        throw new RangeError("Random movement must be between 0 and 1");
      }
      const changeRate = (randomValue - 0.5) * 0.01;
      const nextPriceMinor = Math.max(
        1,
        Math.round(previous.lastPriceMinor * (1 + changeRate))
      );
      if (!Number.isSafeInteger(nextPriceMinor)) {
        throw new RangeError("Market price must be a safe integer");
      }
      const changePercent =
        ((nextPriceMinor - previous.openPriceMinor) / previous.openPriceMinor) *
        100;
      if (!Number.isFinite(changePercent)) {
        throw new RangeError("Market change must be finite");
      }
      // 一秒一个点，只保留最近 60 个点供前端迷你走势图使用。
      const history = [
        ...previous.history,
        { priceMinor: nextPriceMinor, at: this.clock.now() }
      ].slice(-60);
      return {
        ...previous,
        lastPriceMinor: nextPriceMinor,
        changePercent,
        history
      } satisfies StockQuote;
    });

    for (const quote of nextQuotes) {
      this.state.quotes.set(quote.symbol, quote);
    }
  }

  setBestPrices(): void {
    // 最新参考价来自随机行情，best bid/ask 则来自真实订单簿顶部。
    for (const symbol of SYMBOLS) {
      const quote = this.requireQuote(symbol);
      const top = this.state.books.get(symbol)?.topOfBook();
      this.state.quotes.set(symbol, {
        ...quote,
        bestBidMinor: top?.bestBidMinor ?? null,
        bestAskMinor: top?.bestAskMinor ?? null
      });
    }
  }

  publishAll(): void {
    const drafts: EventDraft[] = this.snapshots().map((quote) => ({
      type: "market.updated",
      audience: { kind: "public" },
      payload: quote
    }));
    this.journal.publish(drafts);
  }

  snapshots(): StockQuote[] {
    return SYMBOLS.map((symbol) => clone(this.requireQuote(symbol)));
  }

  private requireQuote(symbol: SymbolCode): StockQuote {
    const quote = this.state.quotes.get(symbol);
    if (quote === undefined) {
      throw new Error(`Market is not initialized for ${symbol}`);
    }
    return clone(quote);
  }
}
