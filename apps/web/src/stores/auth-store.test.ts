import type { BootstrapResponse } from "@paper/shared";
import { describe, expect, it } from "vitest";

import { ApiClientError } from "../api/http-client.js";
import { createAuthStoreHarness, type AuthHttpClient } from "./auth-store.js";

const bootstrapFixture = (): BootstrapResponse => ({
  user: { id: "user-1", username: "trader_01" },
  account: {
    userId: "user-1",
    cashAvailableMinor: 1_000_000,
    cashFrozenMinor: 0,
    positions: {
      AAPL: { availableQuantity: 0, frozenQuantity: 0 },
      MSFT: { availableQuantity: 0, frozenQuantity: 0 },
      TSLA: { availableQuantity: 0, frozenQuantity: 0 }
    }
  },
  stocks: [],
  orders: [],
  trades: [],
  stateVersion: 1
});

const apiError = (status: number, code: string): ApiClientError =>
  new ApiClientError(status, code, "请先登录。", "request-1");

const fakeHttp = (options: {
  bootstrap?: BootstrapResponse;
  bootstrapError?: ApiClientError;
  logoutError?: Error;
}): AuthHttpClient => ({
  get: async <T>(path: string): Promise<T> => {
    if (path !== "/api/bootstrap") throw new Error(`Unexpected GET ${path}`);
    if (options.bootstrapError) throw options.bootstrapError;
    return options.bootstrap as T;
  },
  post: async <T>(path: string): Promise<T> => {
    if (path !== "/api/auth/logout") throw new Error(`Unexpected POST ${path}`);
    if (options.logoutError) throw options.logoutError;
    return undefined as T;
  }
});

describe("auth store", () => {
  it("explicitly invalidates a locally authenticated session", async () => {
    const store = createAuthStoreHarness(
      fakeHttp({ bootstrap: bootstrapFixture() })
    );
    await store.restore();

    store.invalidate();

    expect(store.user).toBeNull();
    expect(store.status).toBe("anonymous");
  });

  it("loads identity from bootstrap", async () => {
    const store = createAuthStoreHarness(
      fakeHttp({ bootstrap: bootstrapFixture() })
    );

    await store.restore();

    expect(store.user?.username).toBe("trader_01");
    expect(store.status).toBe("authenticated");
  });

  it("clears identity when bootstrap returns 401", async () => {
    const store = createAuthStoreHarness(
      fakeHttp({ bootstrapError: apiError(401, "UNAUTHORIZED") })
    );

    await store.restore();

    expect(store.user).toBeNull();
    expect(store.status).toBe("anonymous");
  });

  it("does not retry a completed failed bootstrap during the same app session", async () => {
    let attempts = 0;
    const http = fakeHttp({ bootstrapError: apiError(401, "UNAUTHORIZED") });
    const originalGet = http.get;
    http.get = async <T>(path: string): Promise<T> => {
      attempts += 1;
      return originalGet<T>(path);
    };
    const store = createAuthStoreHarness(http);

    await store.restore();
    await store.restore();

    expect(attempts).toBe(1);
    expect(store.status).toBe("anonymous");
  });

  it("keeps server-backed identity when logout fails", async () => {
    const store = createAuthStoreHarness(
      fakeHttp({
        bootstrap: bootstrapFixture(),
        logoutError: new Error("offline")
      })
    );
    await store.restore();

    await expect(store.logout()).rejects.toThrow("offline");

    expect(store.user?.username).toBe("trader_01");
    expect(store.status).toBe("authenticated");
  });

  it("clears local identity for any HTTP 401 logout response", async () => {
    const store = createAuthStoreHarness(
      fakeHttp({
        bootstrap: bootstrapFixture(),
        logoutError: apiError(401, "HTTP_ERROR")
      })
    );
    await store.restore();

    await expect(store.logout()).rejects.toMatchObject({ code: "HTTP_ERROR" });

    expect(store.user).toBeNull();
    expect(store.status).toBe("anonymous");
  });

  it("keeps local identity for a 5xx logout response", async () => {
    const store = createAuthStoreHarness(
      fakeHttp({
        bootstrap: bootstrapFixture(),
        logoutError: apiError(503, "HTTP_ERROR")
      })
    );
    await store.restore();

    await expect(store.logout()).rejects.toMatchObject({ status: 503 });

    expect(store.user?.username).toBe("trader_01");
    expect(store.status).toBe("authenticated");
  });
});
