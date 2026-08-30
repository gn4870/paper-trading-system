import { LiquidityService } from "../liquidity/liquidity-service.js";
import { MarketSimulator } from "./market-simulator.js";

export interface IntervalScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export type TickErrorHandler = (error: unknown) => void;

const defaultScheduler: IntervalScheduler = {
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: (handle) =>
    globalThis.clearInterval(
      handle as ReturnType<typeof globalThis.setInterval>
    )
};

const defaultErrorHandler: TickErrorHandler = (error) => {
  console.error("Market tick failed", error);
};

export class MarketCycle {
  private timer: { handle: unknown } | undefined;

  constructor(
    private readonly market: MarketSimulator,
    private readonly liquidity: LiquidityService,
    private readonly scheduler: IntervalScheduler = defaultScheduler,
    private readonly onTickError: TickErrorHandler = defaultErrorHandler
  ) {}

  tick(): void {
    this.market.advanceAll();
    this.liquidity.refreshAll();
    this.market.setBestPrices();
    this.market.publishAll();
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = {
      handle: this.scheduler.setInterval(() => {
        try {
          this.tick();
        } catch (error) {
          this.onTickError(error);
        }
      }, 1_000)
    };
  }

  stop(): void {
    if (this.timer === undefined) return;
    this.scheduler.clearInterval(this.timer.handle);
    this.timer = undefined;
  }
}
