import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const port = Number(process.env.E2E_PORT ?? 4_173);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new RangeError("E2E_PORT must be an integer between 1 and 65535");
}

const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: "list",
  use: {
    baseURL: origin,
    screenshot: "only-on-failure",
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: {
    command: "node apps/server/dist/server.js",
    url: `${origin}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      PAPER_TEST_SEED: "paper-trading-smoke",
      PAPER_TEST_NOW: "2026-08-29T08:00:00.000Z",
      PAPER_TEST_WEB_DIST_DIR: resolve("apps/web/dist")
    }
  }
});
