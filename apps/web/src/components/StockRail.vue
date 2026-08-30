<script setup lang="ts">
import type { StockQuote, SymbolCode } from "@paper/shared";

import { formatMinor, formatPercentMovement } from "./format.js";

defineProps<{ stocks: StockQuote[]; selectedSymbol: SymbolCode }>();
defineEmits<{ select: [symbol: SymbolCode] }>();
const movementClass = (change: number): string =>
  change > 0
    ? "movement--up"
    : change < 0
      ? "movement--down"
      : "movement--flat";
</script>

<template>
  <aside class="stock-rail" aria-labelledby="stock-rail-title">
    <div class="panel-heading">
      <div>
        <p class="panel-kicker">WATCHLIST</p>
        <h2 id="stock-rail-title">股票行情</h2>
      </div>
      <span class="panel-count">{{ stocks.length }}</span>
    </div>
    <ul v-if="stocks.length" class="stock-rail__list" aria-label="可交易股票">
      <li v-for="stock in stocks" :key="stock.symbol">
        <button
          type="button"
          class="stock-card"
          :class="{ 'stock-card--selected': stock.symbol === selectedSymbol }"
          :aria-current="stock.symbol === selectedSymbol ? 'true' : undefined"
          @click="$emit('select', stock.symbol)"
        >
          <span class="stock-card__identity"
            ><strong>{{ stock.symbol }}</strong
            ><small>{{ stock.name }}</small></span
          >
          <span class="stock-card__price">{{
            formatMinor(stock.lastPriceMinor)
          }}</span>
          <span
            class="stock-card__movement"
            :class="movementClass(stock.changePercent)"
            >{{ formatPercentMovement(stock.changePercent) }}</span
          >
        </button>
      </li>
    </ul>
    <p v-else class="empty-state">正在等待行情快照…</p>
  </aside>
</template>
