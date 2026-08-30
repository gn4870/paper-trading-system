import type { Component } from "vue";
import type { RouterHistory } from "vue-router";
import { createRouter, createWebHistory } from "vue-router";

import { useAuthStore, type AuthStore } from "../stores/auth-store.js";
export interface AppRouterOptions {
  history?: RouterHistory;
  getAuthStore?: () => AuthStore;
  components?: { login: Component; register: Component; trade: Component };
}

export const createAppRouter = (options: AppRouterOptions = {}) => {
  const getAuthStore = options.getAuthStore ?? (() => useAuthStore());
  const loginView =
    options.components?.login ?? (() => import("../views/LoginView.vue"));
  const registerView =
    options.components?.register ?? (() => import("../views/RegisterView.vue"));
  const tradeView =
    options.components?.trade ?? (() => import("../views/TradeView.vue"));
  let restorePromise: Promise<void> | undefined;
  const router = createRouter({
    history: options.history ?? createWebHistory(),
    routes: [
      { path: "/", redirect: "/trade" },
      { path: "/login", name: "login", component: loginView },
      { path: "/register", name: "register", component: registerView },
      {
        path: "/trade",
        name: "trade",
        component: tradeView,
        meta: { requiresAuth: true }
      },
      { path: "/:pathMatch(.*)*", name: "not-found", component: loginView }
    ]
  });

  router.beforeEach(async (to) => {
    const auth = getAuthStore();
    if (auth.status === "unknown") {
      restorePromise ??= auth.restore();
      await restorePromise;
    }

    const authenticated = auth.status === "authenticated";
    if (to.name === "not-found")
      return { name: authenticated ? "trade" : "login" };
    if (to.meta.requiresAuth && !authenticated) return { name: "login" };
    if ((to.name === "login" || to.name === "register") && authenticated) {
      return { name: "trade" };
    }
    return true;
  });

  return router;
};
