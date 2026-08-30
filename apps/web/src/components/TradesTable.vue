<script setup lang="ts">
import type { Trade } from "@paper/shared";

import { formatDateTime, formatMinor } from "./format.js";

defineProps<{ trades: Trade[]; userId: string }>();
</script>

<template>
  <div class="table-scroll">
    <table aria-label="最近成交">
      <caption class="sr-only">
        当前用户最近成交记录
      </caption>
      <thead>
        <tr>
          <th scope="col">时间</th>
          <th scope="col">股票</th>
          <th scope="col">方向</th>
          <th scope="col">成交价</th>
          <th scope="col">数量</th>
          <th scope="col">成交额</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="trades.length === 0">
          <td colspan="6"><p class="table-empty">暂无成交记录。</p></td>
        </tr>
        <tr v-for="trade in trades" v-else :key="trade.id">
          <td class="mono table-time">
            {{ formatDateTime(trade.executedAt) }}
          </td>
          <td>
            <strong>{{ trade.symbol }}</strong>
          </td>
          <td>
            <span
              class="side-label"
              :class="
                trade.buyerId === userId ? 'movement--up' : 'movement--down'
              "
              >{{ trade.buyerId === userId ? "买入" : "卖出" }}</span
            >
          </td>
          <td class="mono">{{ formatMinor(trade.priceMinor) }}</td>
          <td>{{ trade.quantity }}</td>
          <td class="mono">
            {{ formatMinor(BigInt(trade.priceMinor) * BigInt(trade.quantity)) }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
