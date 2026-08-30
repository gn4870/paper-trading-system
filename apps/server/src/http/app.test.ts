import crypto from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { AccountLedger } from "../accounts/account-ledger.js";
import { AuthService } from "../auth/auth-service.js";
import {
  EventJournal,
  type Clock,
  type IdGenerator
} from "../infrastructure/event-journal.js";
import { MemoryState } from "../infrastructure/memory-state.js";
import { MarketSimulator } from "../market/market-simulator.js";
import { OrderService } from "../orders/order-service.js";
import { createApp, type AppLogEntry } from "./app.js";

const instant = "2026-08-29T00:00:00.000Z";

const createHttpHarness = (initializeMarket = true) => {
  const state = new MemoryState();
  const ledger = new AccountLedger(state);
  const clock: Clock = { now: () => instant };
  let entityId = 0;
  const ids: IdGenerator = { next: () => `entity-${++entityId}` };
  const journal = new EventJournal(clock, ids);
  const orders = new OrderService(state, ledger, journal, clock, ids);
  const market = new MarketSimulator(state, journal, clock, {
    next: () => 0.5
  });
  if (initializeMarket) market.initialize();
  const auth = new AuthService(state, ledger, clock, ids);
  const logs: AppLogEntry[] = [];
  let requestId = 0;
  let time = 1_000;
  const app = createApp({
    state,
    ledger,
    auth,
    orders,
    market,
    journal,
    requestIds: { next: () => `request-${++requestId}` },
    nowMs: () => {
      time += 5;
      return time;
    },
    log: (entry) => logs.push(entry)
  });

  const loginAgent = async () => {
    const agent = request.agent(app);
    await agent
      .post("/api/auth/register")
      .send({ username: "trader_01", password: "safe-pass-123" })
      .expect(201);
    return agent;
  };

  return {
    app,
    state,
    ledger,
    auth,
    orders,
    market,
    journal,
    logs,
    loginAgent
  };
};

const expectApiError = (
  body: unknown,
  code: string,
  requestId: string
): void => {
  expect(body).toEqual({
    error: {
      code,
      message: expect.any(String),
      requestId
    }
  });
};

describe("createApp", () => {
  it("registers, sets a same-origin HttpOnly cookie, and returns bootstrap", async () => {
    const h = createHttpHarness();
    const agent = request.agent(h.app);

    const registration = await agent
      .post("/api/auth/register")
      .send({ username: " Trader_01 ", password: "safe-pass-123" })
      .expect(201);

    expect(registration.body.user).toEqual({
      id: "entity-1",
      username: "trader_01"
    });
    expect(registration.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    expect(registration.headers["set-cookie"]?.[0]).toContain("SameSite=Lax");
    expect(registration.headers["set-cookie"]?.[0]).not.toContain("Domain=");

    const bootstrap = await agent.get("/api/bootstrap").expect(200);
    expect(bootstrap.body).toMatchObject({
      user: { id: "entity-1", username: "trader_01" },
      account: { cashAvailableMinor: 100_000_000 },
      orders: [],
      trades: [],
      stateVersion: 0
    });
    expect(bootstrap.body.stocks).toHaveLength(3);
  });

  it.each([
    ["get", "/api/bootstrap"],
    ["post", "/api/orders"],
    ["delete", "/api/orders/order-1"]
  ] as const)("rejects unauthenticated %s %s", async (method, path) => {
    const h = createHttpHarness();

    const response = await request(h.app)[method](path).expect(401);

    expectApiError(response.body, "UNAUTHORIZED", "request-1");
  });

  it("logs in with normalized credentials and logout destroys and clears the session", async () => {
    const h = createHttpHarness();
    await h.auth.register("Trader_01", "safe-pass-123");
    const agent = request.agent(h.app);

    const login = await agent
      .post("/api/auth/login")
      .send({ username: " TRADER_01 ", password: "safe-pass-123" })
      .expect(200);
    expect(login.body.user.username).toBe("trader_01");
    expect(h.state.sessions).toHaveLength(2);

    const logout = await agent.post("/api/auth/logout").expect(204);
    expect(logout.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
    expect(h.state.sessions).toHaveLength(1);
    await agent.get("/api/bootstrap").expect(401);
  });

  it("does not reveal whether login failed for username or password", async () => {
    const h = createHttpHarness();
    await h.auth.register("trader_01", "safe-pass-123");

    const unknown = await request(h.app)
      .post("/api/auth/login")
      .send({ username: "missing_01", password: "safe-pass-123" })
      .expect(401);
    const wrong = await request(h.app)
      .post("/api/auth/login")
      .send({ username: "trader_01", password: "wrong-pass-123" })
      .expect(401);

    expect(unknown.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(wrong.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it("places and cancels orders through the real order service", async () => {
    const h = createHttpHarness();
    const agent = await h.loginAgent();
    const clientOrderId = crypto.randomUUID();

    const placed = await agent
      .post("/api/orders")
      .send({
        clientOrderId,
        symbol: "AAPL",
        side: "BUY",
        limitPriceMinor: 10_000,
        quantity: 2
      })
      .expect(201);
    expect(placed.body).toMatchObject({
      order: { clientOrderId, status: "OPEN" },
      trades: [],
      replayed: false
    });

    const replayed = await agent
      .post("/api/orders")
      .send({
        clientOrderId,
        symbol: "AAPL",
        side: "BUY",
        limitPriceMinor: 1,
        quantity: 1
      })
      .expect(200);
    expect(replayed.body).toMatchObject({
      order: { id: placed.body.order.id },
      trades: [],
      replayed: true
    });

    const canceled = await agent
      .delete(`/api/orders/${placed.body.order.id}`)
      .expect(200);
    expect(canceled.body.order.status).toBe("CANCELED");
  });

  it("returns a stable insufficient-funds conflict", async () => {
    const h = createHttpHarness();
    const agent = await h.loginAgent();

    const response = await agent
      .post("/api/orders")
      .send({
        clientOrderId: crypto.randomUUID(),
        symbol: "AAPL",
        side: "BUY",
        limitPriceMinor: 100_000_000,
        quantity: 2
      })
      .expect(409);

    expectApiError(response.body, "INSUFFICIENT_FUNDS", "request-2");
  });

  it("maps malformed JSON to 400 and invalid fields to 422", async () => {
    const h = createHttpHarness();

    const malformed = await request(h.app)
      .post("/api/auth/register")
      .set("Content-Type", "application/json")
      .send('{"username":')
      .expect(400);
    const invalid = await request(h.app)
      .post("/api/auth/register")
      .send({ username: "x", password: "short" })
      .expect(422);

    expectApiError(malformed.body, "INVALID_JSON", "request-1");
    expectApiError(invalid.body, "VALIDATION_ERROR", "request-2");
  });

  it("maps duplicate usernames to 409 and missing resources to 404", async () => {
    const h = createHttpHarness();
    await request(h.app)
      .post("/api/auth/register")
      .send({ username: "Trader_01", password: "safe-pass-123" })
      .expect(201);

    const duplicate = await request(h.app)
      .post("/api/auth/register")
      .send({ username: "trader_01", password: "different-123" })
      .expect(409);
    const missing = await request(h.app).get("/api/not-here").expect(404);

    expectApiError(duplicate.body, "USERNAME_TAKEN", "request-2");
    expectApiError(missing.body, "NOT_FOUND", "request-3");
  });

  it("maps unknown failures to a non-leaking 500 response", async () => {
    const h = createHttpHarness(false);
    const agent = await h.loginAgent();

    const response = await agent.get("/api/bootstrap").expect(500);

    expect(response.body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "服务器内部错误",
        requestId: "request-2"
      }
    });
    expect(JSON.stringify(response.body)).not.toContain(
      "Market is not initialized"
    );
    expect(JSON.stringify(response.body)).not.toContain("at ");
    expect(h.logs).toContainEqual({
      requestId: "request-2",
      error: expect.stringContaining("Market is not initialized"),
      stack: expect.stringContaining("Market is not initialized")
    });
    expect(JSON.stringify(h.logs)).not.toContain("safe-pass-123");
    expect(JSON.stringify(h.logs)).not.toContain("cookie");
    expect(JSON.stringify(h.logs)).not.toContain("body");
  });

  it("treats malformed cookie input as unauthenticated instead of crashing", async () => {
    const h = createHttpHarness();

    const response = await request(h.app)
      .get("/api/bootstrap")
      .set("Cookie", "paper_session=%E0%A4%A")
      .expect(401);

    expectApiError(response.body, "UNAUTHORIZED", "request-1");
  });

  it("records bounded request metadata without cookie or password data", async () => {
    const h = createHttpHarness();

    await request(h.app)
      .post("/api/auth/register")
      .set("Cookie", "unrelated=secret-cookie")
      .send({ username: "trader_01", password: "safe-pass-123" })
      .expect(201);

    expect(h.logs).toEqual([
      {
        requestId: "request-1",
        method: "POST",
        path: "/api/auth/register",
        status: 201,
        durationMs: 5
      }
    ]);
    expect(JSON.stringify(h.logs)).not.toContain("safe-pass-123");
    expect(JSON.stringify(h.logs)).not.toContain("secret-cookie");
  });

  it("records request metadata with the default logger", async () => {
    const h = createHttpHarness();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let requestId = 0;
    let time = 100;
    const app = createApp({
      state: h.state,
      ledger: h.ledger,
      auth: h.auth,
      orders: h.orders,
      market: h.market,
      journal: h.journal,
      requestIds: { next: () => `default-${++requestId}` },
      nowMs: () => {
        time += 2;
        return time;
      }
    });

    await request(app).get("/api/health").expect(200);

    expect(info).toHaveBeenCalledWith({
      requestId: "default-1",
      method: "GET",
      path: "/api/health",
      status: 200,
      durationMs: 2
    });
    info.mockRestore();
  });

  it("exposes only an unauthenticated process-health response", async () => {
    const h = createHttpHarness();

    const response = await request(h.app).get("/api/health").expect(200);

    expect(response.body).toEqual({
      status: "ok",
      marketLoop: { active: false }
    });
  });
});
