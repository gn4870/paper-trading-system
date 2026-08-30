/**
 * 一秒行情周期的生命周期控制器。
 *
 * 顺序不能随意调整：先推进参考价，再围绕新价格刷新系统盘口，然后读取新的
 * 最佳买卖价并发布最终行情。start/stop 保证同一实例最多持有一个定时器。
 */
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
          // 单次行情失败只记录错误，不能让周期定时器永久停止。
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
