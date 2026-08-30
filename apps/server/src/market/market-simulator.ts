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
