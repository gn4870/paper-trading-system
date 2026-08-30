<script setup lang="ts">
import type { PlaceOrderRequest, SymbolCode } from "@paper/shared";
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from "vue";
import { useRouter } from "vue-router";

import { ApiClientError, HttpClient } from "../api/http-client.js";
import AccountPanel from "../components/AccountPanel.vue";
import ActivityTabs from "../components/ActivityTabs.vue";
import ConnectionStatus from "../components/ConnectionStatus.vue";
import { formatMinor, formatPercentMovement } from "../components/format.js";
import OrderForm from "../components/OrderForm.vue";
import PriceSparkline from "../components/PriceSparkline.vue";
import StockRail from "../components/StockRail.vue";
import { useAuthStore } from "../stores/auth-store.js";
import { useRealtimeStore } from "../stores/realtime-store.js";
import { useTradingStore } from "../stores/trading-store.js";

const auth = useAuthStore();
const trading = useTradingStore();
const realtime = useRealtimeStore();
const router = useRouter();
const http = new HttpClient();
const selectedSymbol = ref<SymbolCode>("AAPL");
const logoutPending = ref(false);
const pageError = ref("");
let mounted = false;
let removeUnauthorizedHandler: (() => void) | undefined;

const selectedQuote = computed(
  () =>
    trading.stocks.find(({ symbol }) => symbol === selectedSymbol.value) ?? null
);
const movementClass = computed(() => {
  const change = selectedQuote.value?.changePercent ?? 0;
  return change > 0
    ? "movement--up"
    : change < 0
      ? "movement--down"
      : "movement--flat";
});

watchEffect(
  () => {
    if (trading.stocks.some(({ symbol }) => symbol === selectedSymbol.value))
      return;
    selectedSymbol.value = trading.stocks[0]?.symbol ?? "AAPL";
  },
  { flush: "sync" }
);

const handleUnauthorized = (): void => {
  if (!mounted) return;
  auth.invalidate();
  realtime.disconnect();
  void router.replace({ name: "login" });
};

const rethrowCommandError = (error: unknown): never => {
  if (error instanceof ApiClientError && error.status === 401)
    handleUnauthorized();
  throw error;
};

const placeOrder = async (request: PlaceOrderRequest): Promise<void> => {
  try {
    await http.placeOrder(request);
  } catch (error: unknown) {
    rethrowCommandError(error);
  }
};

const cancelOrder = async (orderId: string): Promise<void> => {
  try {
    await http.cancelOrder(orderId);
  } catch (error: unknown) {
    rethrowCommandError(error);
  }
};

const selectSymbol = (symbol: SymbolCode): void => {
  selectedSymbol.value = symbol;
};

const logout = async (): Promise<void> => {
  if (logoutPending.value) return;
  logoutPending.value = true;
  pageError.value = "";
  realtime.disconnect();
  try {
    await auth.logout();
    await router.replace({ name: "login" });
  } catch {
    if (auth.status === "anonymous") {
      await router.replace({ name: "login" });
      return;
    }
    pageError.value = "退出未完成，请检查网络后重试。";
    if (mounted) void realtime.connect().catch(() => undefined);
  } finally {
    logoutPending.value = false;
  }
};

onMounted(() => {
  mounted = true;
  removeUnauthorizedHandler = realtime.onUnauthorized(handleUnauthorized);
  void realtime.connect().catch(() => {
    if (mounted && !logoutPending.value)
      pageError.value = "实时连接暂时不可用，系统将继续尝试恢复。";
  });
});

onBeforeUnmount(() => {
  mounted = false;
  removeUnauthorizedHandler?.();
  removeUnauthorizedHandler = undefined;
  realtime.disconnect();
});
</script>

<template>
  <main class="terminal">
    <header class="terminal__header">
      <div class="terminal-brand" aria-label="模拟证券交易终端">
        <span class="terminal-brand__mark" aria-hidden="true">PT</span>
        <div>
          <p>PAPER MARKET</p>
          <h1>模拟证券交易终端</h1>
        </div>
      </div>
      <div class="terminal-session">
        <ConnectionStatus :status="realtime.connectionStatus" />
        <span class="terminal-session__divider" aria-hidden="true"></span>
        <div class="terminal-user">
          <span aria-hidden="true">账户</span
          ><strong :title="auth.user?.username">{{
            auth.user?.username ?? "--"
          }}</strong>
        </div>
        <button
          type="button"
          class="logout-button"
          data-action="logout"
          :disabled="logoutPending"
          @click="logout"
        >
          {{ logoutPending ? "退出中…" : "退出" }}
        </button>
      </div>
    </header>

    <p
      v-if="pageError"
      class="terminal__alert inline-alert inline-alert--error"
      role="alert"
    >
      {{ pageError }}
    </p>

    <StockRail
      class="terminal__symbols"
      :stocks="trading.stocks"
      :selected-symbol="selectedSymbol"
      @select="selectSymbol"
    />

    <section
      class="terminal__trade panel"
      aria-labelledby="selected-stock-title"
    >
      <div class="market-overview">
        <div>
          <p class="panel-kicker">MARKET / {{ selectedSymbol }}</p>
          <div class="market-title">
            <h2 id="selected-stock-title">{{ selectedSymbol }}</h2>
            <span>{{ selectedQuote?.name ?? "等待行情" }}</span>
          </div>
        </div>
        <div class="market-last">
          <span>最新价</span>
          <strong>{{
            selectedQuote ? formatMinor(selectedQuote.lastPriceMinor) : "--"
          }}</strong>
          <small :class="movementClass">{{
            selectedQuote
              ? formatPercentMovement(selectedQuote.changePercent)
              : "--"
          }}</small>
        </div>
      </div>
      <div class="chart-frame">
        <div class="chart-frame__label">
          <span>最近 60 秒</span><span>实时参考价</span>
        </div>
        <PriceSparkline
          :symbol="selectedSymbol"
          :points="selectedQuote?.history ?? []"
        />
      </div>
      <OrderForm
        :symbol="selectedSymbol"
        :best-bid-minor="selectedQuote?.bestBidMinor ?? null"
        :best-ask-minor="selectedQuote?.bestAskMinor ?? null"
        :submit-order="placeOrder"
      />
    </section>

    <AccountPanel
      class="terminal__account"
      :account="trading.account"
      :symbol="selectedSymbol"
    />

    <ActivityTabs
      class="terminal__activity"
      :orders="trading.orders"
      :account="trading.account"
      :trades="trading.trades"
      :user-id="auth.user?.id ?? trading.account?.userId ?? ''"
      :cancel-order="cancelOrder"
    />
  </main>
</template>
