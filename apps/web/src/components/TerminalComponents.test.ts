import type {
  AccountSnapshot,
  Order,
  PricePoint,
  StockQuote,
  Trade
} from "@paper/shared";
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import AccountPanel from "./AccountPanel.vue";
import ActivityTabs from "./ActivityTabs.vue";
import ConnectionStatus from "./ConnectionStatus.vue";
import OrdersTable from "./OrdersTable.vue";
import PriceSparkline from "./PriceSparkline.vue";
import StockRail from "./StockRail.vue";
import { formatMinor } from "./format.js";

const account: AccountSnapshot = {
  userId: "user-1",
  cashAvailableMinor: 100_000_001,
  cashFrozenMinor: 2_500,
  positions: {
    AAPL: { availableQuantity: 3, frozenQuantity: 1 },
    MSFT: { availableQuantity: 0, frozenQuantity: 0 },
    TSLA: { availableQuantity: 0, frozenQuantity: 0 }
  }
};
const order: Order = {
  id: "order-1",
  clientOrderId: "3ea6e8dc-19b8-43d8-b925-a9ef9a7a4521",
  userId: "user-1",
  symbol: "AAPL",
  side: "BUY",
  limitPriceMinor: 18_700,
  originalQuantity: 10,
  remainingQuantity: 4,
  status: "PARTIALLY_FILLED",
  sequence: 1,
  createdAt: "2026-08-29T10:00:00.000Z",
  updatedAt: "2026-08-29T10:00:01.000Z"
};
const trade: Trade = {
  id: "trade-1",
  symbol: "AAPL",
  buyOrderId: "order-1",
  sellOrderId: "order-2",
  buyerId: "user-1",
  sellerId: "user-2",
  priceMinor: 18_699,
  quantity: 6,
  executedAt: "2026-08-29T10:00:01.000Z",
  sequence: 1
};
const quote = (changePercent: number): StockQuote => ({
  symbol: "AAPL",
  name: "苹果",
  openPriceMinor: 18_700,
  lastPriceMinor: 18_701,
  changePercent,
  bestBidMinor: 18_699,
  bestAskMinor: 18_701,
  history: []
});

describe("terminal presentation components", () => {
  it("formats positive and negative minor-unit values", () => {
    expect(formatMinor(123_456)).toBe("1,234.56");
    expect(formatMinor(-5)).toBe("-0.05");
  });

  it.each([
    ["idle", "尚未连接"],
    ["connecting", "正在连接"],
    ["live", "实时连接正常"],
    ["reconnecting", "连接中断，正在重连"],
    ["offline", "当前离线"]
  ] as const)("maps %s to visible status text", (status, label) => {
    const wrapper = mount(ConnectionStatus, { props: { status } });
    expect(wrapper.text()).toContain(label);
    expect(wrapper.attributes("aria-label")).toContain(label);
  });

  it("expresses quote movement with sign and text, not color alone", () => {
    const wrapper = mount(StockRail, {
      props: {
        stocks: [quote(1.25), { ...quote(-0.8), symbol: "MSFT", name: "微软" }],
        selectedSymbol: "AAPL"
      }
    });
    expect(wrapper.text()).toContain("+1.25% 上涨");
    expect(wrapper.text()).toContain("-0.80% 下跌");
    expect(wrapper.get("[aria-current=true]").text()).toContain("AAPL");
    expect(wrapper.findAll("li")).toHaveLength(2);
    expect(wrapper.get("button").attributes("role")).toBeUndefined();
  });

  it.each([
    [[], "暂无走势数据"],
    [[{ priceMinor: 10_000, at: "2026-08-29T10:00:00Z" }], "1 个价格点"],
    [
      [
        { priceMinor: 10_000, at: "2026-08-29T10:00:00Z" },
        { priceMinor: 10_000, at: "2026-08-29T10:00:01Z" }
      ],
      "2 个价格点"
    ]
  ] satisfies Array<[PricePoint[], string]>)(
    "renders sparkline edge case %#",
    (points, description) => {
      const wrapper = mount(PriceSparkline, {
        props: { symbol: "AAPL", points }
      });
      expect(wrapper.get("svg").attributes("viewBox")).toBe("0 0 320 100");
      expect(wrapper.get("svg desc").text()).toContain(description);
      if (points.length > 0)
        expect(wrapper.get("polyline").attributes("points")).not.toContain(
          "NaN"
        );
    }
  );

  it("shows large balances and the selected holding", () => {
    const wrapper = mount(AccountPanel, { props: { account, symbol: "AAPL" } });
    expect(wrapper.text()).toContain("1,000,000.01");
    expect(wrapper.text()).toContain("可用 3 股");
    expect(wrapper.text()).toContain("冻结 1 股");
  });

  it("keeps all tabpanels in the DOM with complete ARIA relationships", async () => {
    const wrapper = mount(ActivityTabs, {
      props: {
        orders: [order],
        account,
        trades: [trade],
        userId: "user-1",
        cancelOrder: vi.fn().mockResolvedValue(undefined)
      }
    });
    const tabs = wrapper.findAll('[role="tab"]');
    const panels = wrapper.findAll('[role="tabpanel"]');
    expect(tabs).toHaveLength(3);
    expect(panels).toHaveLength(3);
    for (const tab of tabs) {
      const panelId = tab.attributes("aria-controls");
      expect(wrapper.find(`#${panelId}`).exists()).toBe(true);
      expect(wrapper.find(`#${panelId}`).attributes("aria-labelledby")).toBe(
        tab.attributes("id")
      );
    }
    expect(tabs.map((tab) => tab.attributes("aria-selected"))).toEqual([
      "true",
      "false",
      "false"
    ]);
    expect(tabs.map((tab) => tab.attributes("tabindex"))).toEqual([
      "0",
      "-1",
      "-1"
    ]);
    await tabs[1]!.trigger("click");
    expect(wrapper.get("#activity-panel-orders").isVisible()).toBe(false);
    expect(wrapper.get("#activity-panel-holdings").isVisible()).toBe(true);
  });

  it("keeps a successful cancel locked until an authoritative order update", async () => {
    let finishCancel: (() => void) | undefined;
    const cancelOrder = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCancel = resolve;
        })
    );
    const wrapper = mount(ActivityTabs, {
      props: {
        orders: [
          order,
          { ...order, id: "order-2", status: "FILLED", remainingQuantity: 0 }
        ],
        account,
        trades: [trade],
        userId: "user-1",
        cancelOrder
      }
    });
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(3);
    expect(wrapper.get("table").attributes("aria-label")).toContain("委托");
    expect(wrapper.text()).toContain("已成交 6");
    expect(wrapper.findAll("[data-action=cancel]")).toHaveLength(1);
    await wrapper.get("[data-action=cancel]").trigger("click");
    await wrapper.get("[data-action=cancel]").trigger("click");
    expect(cancelOrder).toHaveBeenCalledTimes(1);
    expect(
      wrapper.get("[data-action=cancel]").attributes("disabled")
    ).toBeDefined();
    finishCancel?.();
    await flushPromises();
    expect(
      wrapper.get("[data-action=cancel]").attributes("disabled")
    ).toBeDefined();
    await wrapper.get("[data-action=cancel]").trigger("click");
    expect(cancelOrder).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ orders: [{ ...order, status: "CANCELED" }] });
    await flushPromises();
    expect(
      wrapper.findComponent(OrdersTable).props("cancelingOrderIds")
    ).toEqual([]);
  });

  it("shows a Chinese API error after a failed cancel", async () => {
    const wrapper = mount(ActivityTabs, {
      props: {
        orders: [order],
        account,
        trades: [],
        userId: "user-1",
        cancelOrder: vi.fn().mockRejectedValue(new Error("boom"))
      }
    });
    await wrapper.get("[data-action=cancel]").trigger("click");
    await flushPromises();
    expect(wrapper.get("[role=alert]").text()).toContain("撤单未完成");
    expect(
      wrapper.get("[data-action=cancel]").attributes("disabled")
    ).toBeUndefined();
  });
});
