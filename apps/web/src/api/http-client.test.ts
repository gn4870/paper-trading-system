import { describe, expect, it } from "vitest";

import type { PlaceOrderRequest } from "@paper/shared";

import { ApiClientError, HttpClient } from "./http-client.js";

describe("HttpClient", () => {
  it("loads the trading bootstrap from the same-origin endpoint", async () => {
    let request: Request | undefined;
    const client = new HttpClient({
      fetchImpl: async (input) => {
        request = input as Request;
        return new Response(JSON.stringify({ stateVersion: 7 }), {
          status: 200
        });
      }
    });

    const response = await client.bootstrap();

    expect(request?.url).toBe("http://localhost:3000/api/bootstrap");
    expect(response.stateVersion).toBe(7);
  });

  it("sends same-origin JSON requests with URL-encoded query values", async () => {
    let request: Request | undefined;
    const client = new HttpClient({
      fetchImpl: async (input) => {
        request = input as Request;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    });

    await client.post(
      "/api/orders",
      { symbol: "AAPL" },
      { note: "AAPL & MSFT" }
    );

    expect(request?.url).toContain("note=AAPL+%26+MSFT");
    expect(request?.credentials).toBe("include");
    expect(request?.headers.get("content-type")).toBe("application/json");
    await expect(request?.json()).resolves.toEqual({ symbol: "AAPL" });
  });

  it("returns undefined for a 204 response", async () => {
    const client = new HttpClient({
      fetchImpl: async () => new Response(null, { status: 204 })
    });

    await expect(client.post("/api/auth/logout")).resolves.toBeUndefined();
  });

  it("uses the order command endpoints", async () => {
    const requests: Request[] = [];
    const client = new HttpClient({
      fetchImpl: async (input) => {
        requests.push(input as Request);
        return new Response(JSON.stringify({ order: { id: "order-1" } }), {
          status: 200
        });
      }
    });
    const order: PlaceOrderRequest = {
      clientOrderId: "3ea6e8dc-19b8-43d8-b925-a9ef9a7a4521",
      symbol: "AAPL",
      side: "BUY",
      limitPriceMinor: 18_700,
      quantity: 2
    };
    await client.placeOrder(order);
    await client.cancelOrder("order / 1");
    expect(requests[0]?.method).toBe("POST");
    await expect(requests[0]?.json()).resolves.toEqual(order);
    expect(requests[1]?.method).toBe("DELETE");
    expect(requests[1]?.url).toBe(
      "http://localhost:3000/api/orders/order%20%2F%201"
    );
  });

  it("normalizes a non-JSON error response", async () => {
    const client = new HttpClient({
      fetchImpl: async () => new Response("proxy failure", { status: 502 })
    });

    await expect(client.get("/api/bootstrap")).rejects.toMatchObject({
      status: 502,
      code: "HTTP_ERROR",
      message: "请求失败（HTTP 502），请稍后重试。"
    } satisfies Partial<ApiClientError>);
  });

  it("normalizes network failures without exposing request details", async () => {
    const client = new HttpClient({
      fetchImpl: async () => Promise.reject(new Error("socket reset"))
    });

    await expect(client.get("/api/bootstrap")).rejects.toMatchObject({
      status: 0,
      code: "NETWORK_ERROR",
      message: "网络连接失败，请检查网络后重试。"
    } satisfies Partial<ApiClientError>);
  });

  it("normalizes a response body read failure", async () => {
    const client = new HttpClient({
      fetchImpl: async () =>
        ({
          status: 200,
          ok: true,
          text: async () => Promise.reject(new TypeError("stream closed"))
        }) as Response
    });

    await expect(client.get("/api/bootstrap")).rejects.toMatchObject({
      status: 0,
      code: "NETWORK_ERROR",
      message: "网络连接失败，请检查网络后重试。"
    } satisfies Partial<ApiClientError>);
  });

  it("preserves an existing ApiClientError while reading a response body", async () => {
    const expected = new ApiClientError(
      401,
      "HTTP_ERROR",
      "请重新登录。",
      "request-401"
    );
    const client = new HttpClient({
      fetchImpl: async () =>
        ({
          status: 401,
          ok: false,
          text: async () => Promise.reject(expected)
        }) as Response
    });

    await expect(client.get("/api/bootstrap")).rejects.toBe(expected);
  });
});
