import { createMemoryHistory } from "vue-router";
import { describe, expect, it } from "vitest";

import type { AuthStore } from "../stores/auth-store.js";
import { createAppRouter } from "./index.js";

const views = {
  login: { template: "<div />" },
  register: { template: "<div />" },
  trade: { template: "<div />" }
};

const anonymousStore = (): AuthStore => ({
  user: null,
  status: "unknown",
  restore: async () => {
    store.status = "anonymous";
  },
  register: async () => undefined,
  login: async () => undefined,
  logout: async () => undefined,
  invalidate: () => {
    store.user = null;
    store.status = "anonymous";
  }
});

let store: AuthStore;

describe("app router", () => {
  it("restores once before redirecting an anonymous visitor from trade to login", async () => {
    store = anonymousStore();
    let restores = 0;
    store.restore = async () => {
      restores += 1;
      await Promise.resolve();
      store.status = "anonymous";
    };
    const router = createAppRouter({
      history: createMemoryHistory(),
      getAuthStore: () => store,
      components: views
    });

    await Promise.all([router.push("/trade"), router.push("/trade")]);
    await router.isReady();

    expect(router.currentRoute.value.name).toBe("login");
    expect(restores).toBe(1);
  });

  it("redirects an authenticated visitor away from login", async () => {
    store = {
      ...anonymousStore(),
      status: "authenticated",
      user: { id: "user-1", username: "trader_01" }
    };
    const router = createAppRouter({
      history: createMemoryHistory(),
      getAuthStore: () => store,
      components: views
    });

    await router.push("/login");
    await router.isReady();

    expect(router.currentRoute.value.name).toBe("trade");
  });

  it("uses identity-aware fallbacks for unknown routes", async () => {
    store = {
      ...anonymousStore(),
      status: "authenticated",
      user: { id: "user-1", username: "trader_01" }
    };
    const authenticatedRouter = createAppRouter({
      history: createMemoryHistory(),
      getAuthStore: () => store,
      components: views
    });
    await authenticatedRouter.push("/missing");
    await authenticatedRouter.isReady();

    expect(authenticatedRouter.currentRoute.value.name).toBe("trade");

    store = anonymousStore();
    const anonymousRouter = createAppRouter({
      history: createMemoryHistory(),
      getAuthStore: () => store,
      components: views
    });
    await anonymousRouter.push("/missing");
    await anonymousRouter.isReady();

    expect(anonymousRouter.currentRoute.value.name).toBe("login");
  });
});
