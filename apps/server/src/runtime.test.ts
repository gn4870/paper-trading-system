import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IntervalScheduler } from "./market/market-cycle.js";
import type { RealtimeScheduler } from "./realtime/realtime-hub.js";
import { createRuntime, type Runtime } from "./runtime.js";
import { installShutdownHandlers, runServer } from "./server.js";

interface ScheduledInterval {
  callback: () => void;
  delayMs: number;
  nextAt: number;
}

const createFakeTimers = () => {
  let now = 0;
  let nextHandle = 0;
  const intervals = new Map<number, ScheduledInterval>();
  const timers: IntervalScheduler & RealtimeScheduler = {
    setInterval: (callback, delayMs) => {
      const handle = ++nextHandle;
      intervals.set(handle, { callback, delayMs, nextAt: now + delayMs });
      return handle;
    },
    clearInterval: (handle) => {
      intervals.delete(handle as number);
    }
  };

  return {
    timers,
    nowMs: () => now,
    advanceBy(durationMs: number) {
      const target = now + durationMs;
      for (;;) {
        const due = [...intervals.entries()]
          .filter(([, interval]) => interval.nextAt <= target)
          .sort(
            ([leftHandle, left], [rightHandle, right]) =>
              left.nextAt - right.nextAt || leftHandle - rightHandle
          )[0];
        if (due === undefined) break;
        const [handle, interval] = due;
        now = interval.nextAt;
        interval.callback();
        if (intervals.get(handle) === interval) {
          interval.nextAt += interval.delayMs;
        }
      }
      now = target;
    },
    activeCount: () => intervals.size
  };
};

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
};

const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
};

describe("createRuntime", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("ignores deterministic test variables outside NODE_ENV=test", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAPER_TEST_SEED", "ignored-seed");
    vi.stubEnv("PAPER_TEST_NOW", "2026-08-29T08:00:00.000Z");
    vi.spyOn(Math, "random").mockReturnValue(0.75);
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("10000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("10000000-0000-4000-8000-000000000002");
    const runtime = createRuntime({
      webDistDir: join(tmpdir(), "missing-web")
    });
    cleanups.push(runtime.stop);

    runtime.market.initialize();
    runtime.market.advanceAll();
    const registration = await runtime.auth.register(
      "production_user",
      "safe-pass-123"
    );

    expect(runtime.market.snapshots()[0]?.lastPriceMinor).toBe(18_747);
    expect(registration.user.id).toBe("10000000-0000-4000-8000-000000000001");
    expect(
      runtime.state.sessions.get(registration.sessionId)?.createdAt
    ).not.toBe("2026-08-29T08:00:00.000Z");
  });

  it("derives stable valid unique IDs, clock, and random movement from a test seed", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PAPER_TEST_SEED", "contract-seed");
    vi.stubEnv("PAPER_TEST_NOW", "2026-08-29T08:00:00.000Z");
    const first = createRuntime();
    const second = createRuntime();
    cleanups.push(first.stop, second.stop);

    first.market.initialize();
    first.market.advanceAll();
    const firstRegistration = await first.auth.register(
      "first_contract_user",
      "safe-pass-123"
    );
    const secondRegistration = await second.auth.register(
      "second_contract_user",
      "safe-pass-123"
    );

    expect(
      first.market.snapshots().map(({ lastPriceMinor }) => lastPriceMinor)
    ).toEqual([18_700, 42_600, 24_400]);
    expect(firstRegistration.user.id).toMatch(
      /^[0-9a-f]{8}-0000-4000-8000-[0-9a-f]{12}$/
    );
    expect(firstRegistration.user.id).toBe(secondRegistration.user.id);
    expect(firstRegistration.sessionId).not.toBe(firstRegistration.user.id);
    expect(
      first.state.sessions.get(firstRegistration.sessionId)?.createdAt
    ).toBe("2026-08-29T08:00:00.000Z");
  });

  it.each([
    ["", "2026-08-29T08:00:00.000Z", "PAPER_TEST_SEED"],
    ["contract-seed", "not-a-clock", "PAPER_TEST_NOW"]
  ])("rejects invalid deterministic configuration", (seed, now, message) => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PAPER_TEST_SEED", seed);
    vi.stubEnv("PAPER_TEST_NOW", now);

    expect(() => createRuntime()).toThrow(message);
  });

  it("uses PAPER_TEST_WEB_DIST_DIR only with the explicit test mode contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paper-e2e-web-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, "index.html"), '<div id="app"></div>');
    vi.stubEnv("PAPER_TEST_SEED", "contract-seed");
    vi.stubEnv("PAPER_TEST_NOW", "2026-08-29T08:00:00.000Z");
    vi.stubEnv("PAPER_TEST_WEB_DIST_DIR", directory);
    vi.stubEnv("NODE_ENV", "staging");
    const staging = createRuntime();
    cleanups.push(staging.stop);

    await request(staging.app)
      .get("/trade")
      .set("Accept", "text/html")
      .expect(404);

    vi.stubEnv("NODE_ENV", "test");
    const testing = createRuntime();
    cleanups.push(testing.stop);
    const response = await request(testing.app)
      .get("/trade")
      .set("Accept", "text/html")
      .expect(200);
    expect(response.text).toContain('<div id="app"></div>');
  });

  it("starts an initial market cycle and owns all recurring resources", async () => {
    const fake = createFakeTimers();
    const runtime = createRuntime({
      timers: fake.timers,
      nowMs: fake.nowMs,
      random: { next: () => 0.5 }
    });
    cleanups.push(runtime.stop);

    const port = await runtime.start(0);

    expect(port).toBeGreaterThan(0);
    expect((runtime.httpServer.address() as AddressInfo).address).toBe(
      "0.0.0.0"
    );
    expect(
      runtime.market.snapshots().every((quote) => quote.history.length === 2)
    ).toBe(true);
    expect(runtime.state.books).toHaveLength(3);
    expect(fake.activeCount()).toBe(3);

    fake.advanceBy(1_000);
    expect(
      runtime.market.snapshots().every((quote) => quote.history.length === 3)
    ).toBe(true);

    await runtime.stop();
    expect(fake.activeCount()).toBe(0);
  });

  it("does not install production SPA hosting when the configured web build has no shell", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paper-missing-web-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    let runtime: Runtime;
    try {
      runtime = createRuntime({ webDistDir: join(directory, "missing") });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
    cleanups.push(runtime!.stop);

    const response = await request(runtime!.app)
      .get("/trade")
      .set("Accept", "text/html")
      .expect(404);

    expect(response.type).toBe("application/json");
    expect(response.text).not.toContain('<div id="app"></div>');
  });

  it("coalesces concurrent start calls and makes stop idempotent", async () => {
    const fake = createFakeTimers();
    const runtime = createRuntime({
      timers: fake.timers,
      nowMs: fake.nowMs,
      random: { next: () => 0.5 }
    });
    cleanups.push(runtime.stop);

    const ports = await Promise.all([runtime.start(0), runtime.start(0)]);

    expect(ports[0]).toBe(ports[1]);
    expect(fake.activeCount()).toBe(3);
    await Promise.all([runtime.stop(), runtime.stop()]);
    expect(fake.activeCount()).toBe(0);
  });

  it("rejects every start after the runtime has stopped", async () => {
    const fake = createFakeTimers();
    const runtime = createRuntime({
      timers: fake.timers,
      nowMs: fake.nowMs,
      random: { next: () => 0.5 }
    });
    cleanups.push(runtime.stop);
    await runtime.start(0);
    await runtime.stop();

    await expect(runtime.start(0)).rejects.toThrow("Runtime is stopped");
    await expect(runtime.start(0)).rejects.toThrow("Runtime is stopped");
    expect(fake.activeCount()).toBe(0);
    expect(runtime.httpServer.listening).toBe(false);
  });

  it("rejects startup when stop overlaps the listen operation", async () => {
    const fake = createFakeTimers();
    const runtime = createRuntime({
      timers: fake.timers,
      nowMs: fake.nowMs,
      random: { next: () => 0.5 }
    });
    cleanups.push(runtime.stop);

    const starting = runtime.start(0);
    const stopping = runtime.stop();

    await expect(starting).rejects.toThrow("Runtime stopped during startup");
    await stopping;
    expect(fake.activeCount()).toBe(0);
    expect(runtime.httpServer.listening).toBe(false);
  });

  it("rolls back timers and sockets when listen fails", async () => {
    const occupied = createServer();
    cleanups.push(() => closeServer(occupied));
    const port = await listen(occupied);
    const fake = createFakeTimers();
    const runtime = createRuntime({
      timers: fake.timers,
      nowMs: fake.nowMs,
      random: { next: () => 0.5 }
    });
    cleanups.push(runtime.stop);

    await expect(runtime.start(port)).rejects.toMatchObject({
      code: "EADDRINUSE"
    });

    expect(fake.activeCount()).toBe(0);
    await runtime.stop();
  });

  it("reports timer failures and keeps the market loop alive", async () => {
    const fake = createFakeTimers();
    const errors: unknown[] = [];
    let randomCalls = 0;
    const runtime = createRuntime({
      timers: fake.timers,
      nowMs: fake.nowMs,
      random: {
        next: () => {
          randomCalls += 1;
          if (randomCalls === 4) throw new Error("random unavailable");
          return 0.5;
        }
      },
      onTickError: (error) => errors.push(error)
    });
    cleanups.push(runtime.stop);
    await runtime.start(0);

    fake.advanceBy(1_000);
    fake.advanceBy(1_000);

    expect(errors).toEqual([new Error("random unavailable")]);
    expect(
      runtime.market.snapshots().every((quote) => quote.history.length === 3)
    ).toBe(true);
    expect(fake.activeCount()).toBe(3);
  });

  it("continues realtime and HTTP cleanup when market timer cleanup reports failure", async () => {
    const fake = createFakeTimers();
    let clearCalls = 0;
    const failure = new Error("market timer cleanup failed");
    const timers: IntervalScheduler & RealtimeScheduler = {
      setInterval: fake.timers.setInterval,
      clearInterval: (handle) => {
        fake.timers.clearInterval(handle);
        clearCalls += 1;
        if (clearCalls === 1) throw failure;
      }
    };
    const runtime = createRuntime({
      timers,
      nowMs: fake.nowMs,
      random: { next: () => 0.5 }
    });
    cleanups.push(async () => {
      await runtime.stop().catch(() => undefined);
      await closeServer(runtime.httpServer).catch(() => undefined);
    });
    await runtime.start(0);

    await expect(runtime.stop()).rejects.toBe(failure);

    expect(clearCalls).toBe(3);
    expect(fake.activeCount()).toBe(0);
    expect(runtime.httpServer.listening).toBe(false);
  });

  it("aggregates realtime timer and HTTP close failures after attempting both", async () => {
    const fake = createFakeTimers();
    let clearCalls = 0;
    const timerFailure = new Error("heartbeat cleanup failed");
    const closeFailure = new Error("HTTP close failed");
    const timers: IntervalScheduler & RealtimeScheduler = {
      setInterval: fake.timers.setInterval,
      clearInterval: (handle) => {
        fake.timers.clearInterval(handle);
        clearCalls += 1;
        if (clearCalls === 2) throw timerFailure;
      }
    };
    const runtime = createRuntime({
      timers,
      nowMs: fake.nowMs,
      random: { next: () => 0.5 }
    });
    cleanups.push(async () => {
      await runtime.stop().catch(() => undefined);
      await closeServer(runtime.httpServer).catch(() => undefined);
    });
    await runtime.start(0);
    const originalClose = runtime.httpServer.close.bind(runtime.httpServer);
    runtime.httpServer.close = ((callback?: (error?: Error) => void) => {
      return originalClose(() => callback?.(closeFailure));
    }) as Server["close"];

    const stopping = runtime.stop();

    await expect(stopping).rejects.toBeInstanceOf(AggregateError);
    const error = await stopping.catch((caught: unknown) => caught);
    expect((error as AggregateError).errors).toEqual([
      timerFailure,
      closeFailure
    ]);
    expect(clearCalls).toBe(3);
    expect(fake.activeCount()).toBe(0);
    expect(runtime.httpServer.listening).toBe(false);
  });
});

class FakeProcess extends EventEmitter {
  exitCode: number | undefined;
}

describe("server shutdown", () => {
  it("captures shutdown signals while the HTTP server is still starting", async () => {
    const signals = new FakeProcess();
    let finishStart: (() => void) | undefined;
    const start = vi.fn(
      async () =>
        new Promise<number>((resolve) => {
          finishStart = () => resolve(3000);
        })
    );
    const runtime = {
      start,
      stop: vi.fn(async () => undefined)
    } as unknown as Runtime;

    const running = runServer({ runtime, port: 0, process: signals });

    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    finishStart!();
    const server = await running;
    await server.shutdown();
    expect(start).toHaveBeenCalledWith(0);
  });

  it("coalesces SIGINT and SIGTERM into one successful shutdown", async () => {
    const signals = new FakeProcess();
    const stop = vi.fn(async () => undefined);
    const runtime = { stop } as unknown as Runtime;
    const controller = installShutdownHandlers(runtime, {
      process: signals,
      onError: vi.fn()
    });

    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    await controller.shutdown();

    expect(stop).toHaveBeenCalledOnce();
    expect(signals.exitCode).toBeUndefined();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("sets a nonzero exit code only when shutdown fails", async () => {
    const signals = new FakeProcess();
    const failure = new Error("close failed");
    const onError = vi.fn();
    const runtime = {
      stop: vi.fn(async () => Promise.reject(failure))
    } as unknown as Runtime;
    const controller = installShutdownHandlers(runtime, {
      process: signals,
      onError
    });

    signals.emit("SIGTERM");
    await controller.shutdown();

    expect(signals.exitCode).toBe(1);
    expect(onError).toHaveBeenCalledWith("Server shutdown failed", failure);
  });
});
