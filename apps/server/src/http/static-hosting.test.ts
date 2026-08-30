import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountLedger } from "../accounts/account-ledger.js";
import { AuthService } from "../auth/auth-service.js";
import { EventJournal } from "../infrastructure/event-journal.js";
import { MemoryState } from "../infrastructure/memory-state.js";
import { MarketSimulator } from "../market/market-simulator.js";
import { OrderService } from "../orders/order-service.js";
import { createApp } from "./app.js";

const fixtureDirectories: string[] = [];

const rawHtmlRequest = async (
  app: ReturnType<typeof createApp>,
  path: string
) => {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    const port = (server.address() as AddressInfo).port;
    return await new Promise<{
      status: number;
      contentType: string | undefined;
    }>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path,
          headers: { Accept: "text/html" }
        },
        (response) => {
          response.resume();
          response.once("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              contentType: response.headers["content-type"]
            });
          });
        }
      );
      request.once("error", reject);
      request.end();
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error)
      );
    });
  }
};

const fixtureStaticDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "paper-static-"));
  fixtureDirectories.push(directory);
  await writeFile(
    join(directory, "index.html"),
    '<!doctype html><div id="app"></div>'
  );
  await mkdir(join(directory, "assets"));
  await writeFile(
    join(directory, "assets", "app-12345678.js"),
    "console.log('app');"
  );
  await writeFile(join(directory, "favicon.ico"), "favicon");
  return directory;
};

const createHttpHarness = (staticDirectory?: string) => {
  const state = new MemoryState();
  const ledger = new AccountLedger(state);
  const clock = { now: () => "2026-08-29T00:00:00.000Z" };
  let id = 0;
  const ids = { next: () => `entity-${++id}` };
  const journal = new EventJournal(clock, ids);
  const market = new MarketSimulator(state, journal, clock, {
    next: () => 0.5
  });
  market.initialize();
  const auth = new AuthService(state, ledger, clock, ids);
  const orders = new OrderService(state, ledger, journal, clock, ids);

  return createApp({
    state,
    ledger,
    auth,
    orders,
    market,
    journal,
    ...(staticDirectory === undefined ? {} : { staticDirectory }),
    log: () => undefined
  });
};

afterEach(async () => {
  await Promise.all(
    fixtureDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("production static hosting", () => {
  it("serves the SPA shell for an HTML navigation route", async () => {
    const app = createHttpHarness(await fixtureStaticDirectory());
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const response = await request(app)
        .get("/trade")
        .set("Accept", "text/html")
        .expect(200);

      expect(response.text).toContain('<div id="app"></div>');
      expect(response.headers["cache-control"]).toBe("no-cache");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("keeps the exact API namespace JSON-only even when the web build contains an api directory", async () => {
    const directory = await fixtureStaticDirectory();
    await mkdir(join(directory, "api"));
    await writeFile(join(directory, "api", "shadow"), "static shadow");
    const app = createHttpHarness(directory);

    const exact = await request(app)
      .get("/api")
      .set("Accept", "text/html")
      .expect(404);
    const nested = await request(app)
      .get("/api/shadow")
      .set("Accept", "text/html")
      .expect(404);

    for (const response of [exact, nested]) {
      expect(response.body.error.code).toBe("NOT_FOUND");
      expect(response.body.error.requestId).toEqual(expect.any(String));
      expect(response.type).toBe("application/json");
      expect(response.headers.location).toBeUndefined();
    }
  });

  it("does not rewrite unknown API routes", async () => {
    const app = createHttpHarness(await fixtureStaticDirectory());

    const response = await request(app).get("/api/not-found").expect(404);

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(response.type).toBe("application/json");
  });

  it("reserves safely decoded API and WebSocket namespace prefixes", async () => {
    const app = createHttpHarness(await fixtureStaticDirectory());

    const probes = await Promise.all(
      ["/api%2Fhealth", "/ws%2Fprobe"].map((path) => rawHtmlRequest(app, path))
    );

    expect(probes.map((response) => response.status)).toEqual([404, 404]);
    expect(probes.map((response) => response.contentType)).toEqual([
      expect.stringContaining("application/json"),
      expect.stringContaining("application/json")
    ]);
  });

  it("serves hashed assets with immutable caching and leaves missing assets as 404", async () => {
    const app = createHttpHarness(await fixtureStaticDirectory());

    const asset = await request(app).get("/assets/app-12345678.js").expect(200);
    expect(asset.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable"
    );
    const favicon = await request(app).get("/favicon.ico").expect(200);
    expect(favicon.headers["cache-control"]).toBe("no-cache");

    const missing = await request(app)
      .get("/missing.js")
      .set("Accept", "text/html")
      .expect(404);
    expect(missing.type).toBe("application/json");
  });

  it("only applies history fallback to GET or HEAD HTML requests without a file extension", async () => {
    const app = createHttpHarness(await fixtureStaticDirectory());

    await request(app).head("/orders").set("Accept", "text/html").expect(200);
    await request(app)
      .get("/orders")
      .set("Accept", "application/json")
      .expect(404);
    await request(app)
      .get("/orders.csv")
      .set("Accept", "text/html")
      .expect(404);
    await request(app).post("/orders").set("Accept", "text/html").expect(404);
  });

  it("does not use SPA fallback for ordinary HTTP WebSocket paths or dot-segment paths", async () => {
    const app = createHttpHarness(await fixtureStaticDirectory());

    for (const path of ["/ws", "/.env", "/.git/config"]) {
      const response = await request(app)
        .get(path)
        .set("Accept", "text/html")
        .expect(404);
      expect(response.type).toBe("application/json");
    }
  });

  it("rejects encoded hidden and traversal segments without breaking encoded history routes", async () => {
    const app = createHttpHarness(await fixtureStaticDirectory());

    const probes = await Promise.all(
      ["/%2Eenv", "/%2Egit%2Fconfig", "/%2e%2e/secret", "/%2Egit%5Cconfig"].map(
        (path) => rawHtmlRequest(app, path)
      )
    );
    expect(probes.map((response) => response.status)).toEqual([
      404, 404, 404, 404
    ]);
    expect(probes.map((response) => response.contentType)).toEqual([
      expect.stringContaining("application/json"),
      expect.stringContaining("application/json"),
      expect.stringContaining("application/json"),
      expect.stringContaining("application/json")
    ]);

    const historyRoute = await request(app)
      .get("/%E4%BA%A4%E6%98%93")
      .set("Accept", "text/html")
      .expect(200);
    expect(historyRoute.text).toContain('<div id="app"></div>');

    const malformed = await request(app)
      .get("/malformed%ZZ")
      .set("Accept", "text/html");
    expect(malformed.status).toBeGreaterThanOrEqual(400);
    expect(malformed.status).toBeLessThan(500);
    expect(malformed.type).toBe("application/json");
    expect(malformed.text).not.toContain('<div id="app"></div>');
  });

  it("does not host static files without an explicit directory", async () => {
    const app = createHttpHarness();

    await request(app).get("/trade").set("Accept", "text/html").expect(404);
  });

  it("reports only process health and market-loop state", async () => {
    const app = createHttpHarness(await fixtureStaticDirectory());

    const response = await request(app).get("/api/health").expect(200);

    expect(response.body).toEqual({
      status: "ok",
      marketLoop: { active: false }
    });
  });
});
