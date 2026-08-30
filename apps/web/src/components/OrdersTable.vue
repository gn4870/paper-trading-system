<script setup lang="ts">
import type { Order } from "@paper/shared";

import { formatDateTime, formatMinor } from "./format.js";

const props = defineProps<{
  orders: Order[];
  cancelingOrderId?: string;
  cancelingOrderIds?: string[];
}>();
defineEmits<{ cancel: [orderId: string] }>();
const active = (order: Order): boolean =>
  order.remainingQuantity > 0 &&
  (order.status === "OPEN" || order.status === "PARTIALLY_FILLED");
const canceling = (orderId: string): boolean =>
  props.cancelingOrderId === orderId ||
  props.cancelingOrderIds?.includes(orderId) === true;
const statusLabel: Record<Order["status"], string> = {
  OPEN: "未成交",
  PARTIALLY_FILLED: "部分成交",
  FILLED: "全部成交",
  CANCELED: "已撤销"
};
</script>

<template>
  <div class="table-scroll">
    <table aria-label="当前委托">
      <caption class="sr-only">
        当前用户全部委托
      </caption>
      <thead>
        <tr>
          <th scope="col">时间</th>
          <th scope="col">股票</th>
          <th scope="col">方向</th>
          <th scope="col">限价</th>
          <th scope="col">数量</th>
          <th scope="col">已成交</th>
          <th scope="col">状态</th>
          <th scope="col">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="orders.length === 0">
          <td colspan="8">
            <p class="table-empty">暂无委托，填写上方限价单开始模拟交易。</p>
          </td>
        </tr>
        <tr v-for="order in orders" v-else :key="order.id">
          <td class="mono table-time">{{ formatDateTime(order.createdAt) }}</td>
          <td>
            <strong>{{ order.symbol }}</strong>
          </td>
          <td>
            <span
              class="side-label"
              :class="order.side === 'BUY' ? 'movement--up' : 'movement--down'"
              >{{ order.side === "BUY" ? "买入" : "卖出" }}</span
            >
          </td>
          <td class="mono">{{ formatMinor(order.limitPriceMinor) }}</td>
          <td>{{ order.originalQuantity }}</td>
          <td>
            <span class="sr-only">已成交 </span
            >{{ order.originalQuantity - order.remainingQuantity }}
          </td>
          <td>
            <span
              class="order-status"
              :class="`order-status--${order.status.toLowerCase()}`"
              >{{ statusLabel[order.status] }}</span
            >
          </td>
          <td>
            <button
              v-if="active(order)"
              type="button"
              class="table-action"
              data-action="cancel"
              :disabled="canceling(order.id)"
              :aria-label="`撤销 ${order.symbol} 委托`"
              @click="$emit('cancel', order.id)"
            >
              {{ canceling(order.id) ? "撤单中…" : "撤单" }}</button
            ><span v-else class="muted">—</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
