import type {
  BootstrapResponse,
  PlaceOrderRequest,
  StockQuote
} from "@paper/shared";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClientError, HttpClient } from "../api/http-client.js";
import AccountPanel from "../components/AccountPanel.vue";
import ActivityTabs from "../components/ActivityTabs.vue";
import OrderForm from "../components/OrderForm.vue";
import StockRail from "../components/StockRail.vue";
import { useAuthStore } from "../stores/auth-store.js";
import { useRealtimeStore } from "../stores/realtime-store.js";
import { useTradingStore } from "../stores/trading-store.js";
import TradeView from "./TradeView.vue";

const quote = (symbol: StockQuote["symbol"]): StockQuote => ({
  symbol,
  name: { AAPL: "苹果", MSFT: "微软", TSLA: "特斯拉" }[symbol],
  openPriceMinor: 10_000,
  lastPriceMinor: 10_100,
  changePercent: 1,
  bestBidMinor: 10_099,
  bestAskMinor: 10_101,
  history: [{ priceMinor: 10_100, at: "2026-08-29T10:00:00.000Z" }]
});
const bootstrapFixture = (
  stocks = [quote("AAPL"), quote("MSFT"), quote("TSLA")]
): BootstrapResponse => ({
  user: { id: "user-1", username: "trader_with_a_very_long_name_01" },
  account: {
    userId: "user-1",
    cashAvailableMinor: 100_000_000,
    cashFrozenMinor: 0,
    positions: {
      AAPL: { availableQuantity: 0, frozenQuantity: 0 },
      MSFT: { availableQuantity: 0, frozenQuantity: 0 },
      TSLA: { availableQuantity: 0, frozenQuantity: 0 }
    }
  },
  stocks,
  orders: [],
  trades: [],
  stateVersion: 1
});

const createHarness = async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/trade", name: "trade", component: TradeView },
      {
        path: "/login",
        name: "login",
        component: { template: "<div>登录</div>" }
      }
    ]
  });
  await router.push("/trade");
  const auth = useAuthStore(pinia);
  auth.user = bootstrapFixture().user;
  auth.status = "authenticated";
  const trading = useTradingStore(pinia);
  trading.replaceSnapshot(bootstrapFixture());
  const realtime = useRealtimeStore(pinia);
  const connect = vi.spyOn(realtime, "connect").mockResolvedValue();
  const disconnect = vi
    .spyOn(realtime, "disconnect")
    .mockImplementation(() => undefined);
  let unauthorizedHandler: (() => void) | undefined;
  const removeUnauthorizedHandler = vi.fn();
  const onUnauthorized = vi
    .spyOn(realtime, "onUnauthorized")
    .mockImplementation((handler) => {
      unauthorizedHandler = handler;
      return removeUnauthorizedHandler;
    });
  const wrapper = mount(TradeView, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return {
    auth,
    connect,
    disconnect,
    onUnauthorized,
    removeUnauthorizedHandler,
    router,
    trading,
    unauthorized: () => unauthorizedHandler?.(),
    wrapper
  };
};

afterEach(() => vi.restoreAllMocks());

describe("TradeView", () => {
  it("renders the four terminal regions and lifecycle-connects realtime", async () => {
    const {
      connect,
      disconnect,
      onUnauthorized,
      removeUnauthorizedHandler,
      wrapper
    } = await createHarness();
    expect(wrapper.findComponent(StockRail).exists()).toBe(true);
    expect(wrapper.findComponent(OrderForm).exists()).toBe(true);
    expect(wrapper.findComponent(AccountPanel).exists()).toBe(true);
    expect(wrapper.findComponent(ActivityTabs).exists()).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(removeUnauthorizedHandler).toHaveBeenCalledTimes(1);
  });

  it("changes context and preserves a selected symbol through snapshot replacement", async () => {
    const { trading, wrapper } = await createHarness();
    wrapper.findComponent(StockRail).vm.$emit("select", "MSFT");
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(OrderForm).props("symbol")).toBe("MSFT");
    expect(wrapper.findComponent(AccountPanel).props("symbol")).toBe("MSFT");
    trading.stocks = [quote("TSLA"), quote("MSFT")];
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(OrderForm).props("symbol")).toBe("MSFT");
    trading.stocks = [quote("TSLA")];
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(OrderForm).props("symbol")).toBe("TSLA");
  });

  it("delegates orders without optimistic account changes", async () => {
    const placeOrder = vi
      .spyOn(HttpClient.prototype, "placeOrder")
      .mockResolvedValue({ order: {} as never, trades: [], replayed: false });
    const { trading, wrapper } = await createHarness();
    const before = trading.account?.cashAvailableMinor;
    const request: PlaceOrderRequest = {
      clientOrderId: "3ea6e8dc-19b8-43d8-b925-a9ef9a7a4521",
      symbol: "AAPL",
      side: "BUY",
      limitPriceMinor: 10_101,
      quantity: 1
    };
    await wrapper.findComponent(OrderForm).props("submitOrder")!(request);
    expect(placeOrder).toHaveBeenCalledWith(request);
    expect(trading.account?.cashAvailableMinor).toBe(before);
    expect(trading.orders).toHaveLength(0);
  });

  it.each(["place", "cancel"] as const)(
    "invalidates and navigates on a %s command 401",
    async (command) => {
      vi.spyOn(
        HttpClient.prototype,
        command === "place" ? "placeOrder" : "cancelOrder"
      ).mockRejectedValue(new ApiClientError(401, "UNAUTHORIZED", "login"));
      const { auth, disconnect, router, wrapper } = await createHarness();
      const invalidate = vi.spyOn(auth, "invalidate");

      if (command === "place") {
        await expect(
          wrapper.findComponent(OrderForm).props("submitOrder")!({
            clientOrderId: "3ea6e8dc-19b8-43d8-b925-a9ef9a7a4521",
            symbol: "AAPL",
            side: "BUY",
            limitPriceMinor: 10_101,
            quantity: 1
          })
        ).rejects.toMatchObject({ status: 401 });
      } else {
        await expect(
          wrapper.findComponent(ActivityTabs).props("cancelOrder")("order-1")
        ).rejects.toMatchObject({ status: 401 });
      }
      await flushPromises();

      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(auth.status).toBe("anonymous");
      expect(auth.user).toBeNull();
      expect(disconnect).toHaveBeenCalled();
      expect(router.currentRoute.value.name).toBe("login");
    }
  );

  it("invalidates and navigates when the realtime store reports a server 1008", async () => {
    const { auth, disconnect, router, unauthorized } = await createHarness();

    unauthorized();
    await flushPromises();

    expect(auth.status).toBe("anonymous");
    expect(auth.user).toBeNull();
    expect(disconnect).toHaveBeenCalled();
    expect(router.currentRoute.value.name).toBe("login");
  });

  it("keeps the trader in place on logout failure and reconnects after failure", async () => {
    const { auth, connect, disconnect, router, wrapper } =
      await createHarness();
    vi.spyOn(auth, "logout").mockRejectedValue(new Error("offline"));
    await wrapper.get("[data-action=logout]").trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("trade");
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[role="alert"]').text()).toBe(
      "退出未完成，请检查网络后重试。"
    );
  });

  it("prevents a second logout while the first is pending", async () => {
    const { auth, wrapper } = await createHarness();
    let finish: (() => void) | undefined;
    const logout = vi.spyOn(auth, "logout").mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );
    await wrapper.get("[data-action=logout]").trigger("click");
    await wrapper.get("[data-action=logout]").trigger("click");
    expect(logout).toHaveBeenCalledTimes(1);
    expect(
      wrapper.get("[data-action=logout]").attributes("disabled")
    ).toBeDefined();
    finish?.();
    await flushPromises();
  });
});
