<script setup lang="ts">
/**
 * 委托、持仓和成交三个活动面板的协调组件。
 * 撤单成功后仍保持按钮锁定，直到服务端 order.updated 确认订单已不再活跃，
 * 防止网络响应与实时状态到达顺序不同造成重复撤单。
 */
import type { AccountSnapshot, Order, Trade } from "@paper/shared";
import { ref, watch } from "vue";

import { commandErrorMessage } from "./api-error.js";
import HoldingsTable from "./HoldingsTable.vue";
import OrdersTable from "./OrdersTable.vue";
import TradesTable from "./TradesTable.vue";

type Tab = "orders" | "holdings" | "trades";
const props = defineProps<{
  orders: Order[];
  account: AccountSnapshot | null;
  trades: Trade[];
  userId: string;
  cancelOrder: (orderId: string) => Promise<unknown>;
}>();
const activeTab = ref<Tab>("orders");
const cancelingOrderIds = ref<string[]>([]);
const errorMessage = ref("");
const tabs: Array<{ id: Tab; label: string }> = [
  { id: "orders", label: "当前委托" },
  { id: "holdings", label: "全部持仓" },
  { id: "trades", label: "最近成交" }
];
const orderIsActive = (order: Order): boolean =>
  order.remainingQuantity > 0 &&
  (order.status === "OPEN" || order.status === "PARTIALLY_FILLED");

watch(
  () =>
    props.orders
      .map(
        ({ id, status, remainingQuantity }) =>
          `${id}:${status}:${remainingQuantity}`
      )
      .join("|"),
  () => {
    cancelingOrderIds.value = cancelingOrderIds.value.filter((orderId) => {
      const order = props.orders.find(({ id }) => id === orderId);
      return order !== undefined && orderIsActive(order);
    });
  },
  { flush: "sync" }
);

const setActive = (tab: Tab): void => {
  activeTab.value = tab;
};
const onKeydown = (event: KeyboardEvent, index: number): void => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const offset = event.key === "ArrowRight" ? 1 : -1;
  const next = tabs[(index + offset + tabs.length) % tabs.length]!;
  activeTab.value = next.id;
  document.getElementById(`activity-tab-${next.id}`)?.focus();
};
const cancel = async (orderId: string): Promise<void> => {
  if (cancelingOrderIds.value.includes(orderId)) return;
  errorMessage.value = "";
  cancelingOrderIds.value = [...cancelingOrderIds.value, orderId];
  try {
    await props.cancelOrder(orderId);
  } catch (error: unknown) {
    errorMessage.value = commandErrorMessage(
      error,
      "撤单未完成，请检查网络后重试。"
    );
    cancelingOrderIds.value = cancelingOrderIds.value.filter(
      (id) => id !== orderId
    );
  }
};
</script>

<template>
  <section class="activity-panel panel" aria-labelledby="activity-title">
    <div class="activity-header">
      <div>
        <p class="panel-kicker">ACTIVITY</p>
        <h2 id="activity-title">交易记录</h2>
      </div>
      <div class="activity-tabs" role="tablist" aria-label="交易数据分类">
        <button
          v-for="(tab, index) in tabs"
          :id="`activity-tab-${tab.id}`"
          :key="tab.id"
          type="button"
          role="tab"
          :data-tab="tab.id"
          :aria-selected="activeTab === tab.id"
          :aria-controls="`activity-panel-${tab.id}`"
          :tabindex="activeTab === tab.id ? 0 : -1"
          @click="setActive(tab.id)"
          @keydown="onKeydown($event, index)"
        >
          {{ tab.label
          }}<span v-if="tab.id === 'orders'">{{ orders.length }}</span
          ><span v-else-if="tab.id === 'trades'">{{ trades.length }}</span>
        </button>
      </div>
    </div>
    <p
      v-if="errorMessage"
      class="inline-alert inline-alert--error activity-error"
      role="alert"
    >
      {{ errorMessage }}
    </p>
    <div
      v-show="activeTab === 'orders'"
      id="activity-panel-orders"
      role="tabpanel"
      aria-labelledby="activity-tab-orders"
    >
      <OrdersTable
        :orders="orders"
        :canceling-order-ids="cancelingOrderIds"
        @cancel="cancel"
      />
    </div>
    <div
      v-show="activeTab === 'holdings'"
      id="activity-panel-holdings"
      role="tabpanel"
      aria-labelledby="activity-tab-holdings"
    >
      <HoldingsTable :account="account" />
    </div>
    <div
      v-show="activeTab === 'trades'"
      id="activity-panel-trades"
      role="tabpanel"
      aria-labelledby="activity-tab-trades"
    >
      <TradesTable :trades="trades" :user-id="userId" />
    </div>
  </section>
</template>
