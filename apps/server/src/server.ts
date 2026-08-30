/**
 * 生产进程入口。
 *
 * 解析端口、启动 Runtime，并将 SIGINT/SIGTERM 合并为一次幂等关闭；真正的业务
 * 组装在 runtime.ts 中，使进程入口保持薄层，便于隔离信号和退出码行为。
 */
import { pathToFileURL } from "node:url";

import { createRuntime, type Runtime } from "./runtime.js";

export interface SignalProcess {
  exitCode: number | string | null | undefined;
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface ShutdownOptions {
  process?: SignalProcess;
  onError?: (message: string, error: unknown) => void;
}

export interface ShutdownController {
  shutdown: () => Promise<void>;
  dispose: () => void;
}

export interface RunServerOptions extends ShutdownOptions {
  runtime?: Runtime;
  port?: number;
}

export interface RunningServer {
  runtime: Runtime;
  shutdown: () => Promise<void>;
}

export const installShutdownHandlers = (
  runtime: Runtime,
  options: ShutdownOptions = {}
): ShutdownController => {
  const processLike = options.process ?? process;
  const onError = options.onError ?? console.error;
  let shutdownPromise: Promise<void> | undefined;

  const dispose = (): void => {
    processLike.off("SIGINT", onSignal);
    processLike.off("SIGTERM", onSignal);
  };

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    dispose();
    shutdownPromise = runtime.stop().catch((error: unknown) => {
      processLike.exitCode = 1;
      onError("Server shutdown failed", error);
    });
    return shutdownPromise;
  };

  const onSignal = (): void => {
    void shutdown();
  };

  processLike.once("SIGINT", onSignal);
  processLike.once("SIGTERM", onSignal);
  return { shutdown, dispose };
};

const configuredPort = (): number => {
  const raw = process.env.PORT;
  if (raw === undefined) return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("PORT must be an integer between 0 and 65535");
  }
  return port;
};

export const runServer = async (
  options: RunServerOptions = {}
): Promise<RunningServer> => {
  const runtime = options.runtime ?? createRuntime();
  const controller = installShutdownHandlers(runtime, options);
  try {
    await runtime.start(options.port ?? configuredPort());
  } catch (error) {
    controller.dispose();
    throw error;
  }
  return { runtime, shutdown: controller.shutdown };
};

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(entryPath).href
) {
  void runServer().catch((error: unknown) => {
    console.error("Server startup failed", error);
    process.exitCode = 1;
  });
}
