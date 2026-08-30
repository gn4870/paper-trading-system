<script setup lang="ts">
/**
 * 限价委托输入组件。
 *
 * 负责把用户输入精确转换为“分”和整数数量，并为一次下单意图维护稳定的
 * clientOrderId。网络结果不确定时保留 ID 重试，明确 4xx 或成功后才生成新 ID。
 */
import type { OrderSide, PlaceOrderRequest, SymbolCode } from "@paper/shared";
import { computed, ref, watch } from "vue";

import { ApiClientError } from "../api/http-client.js";
import { commandErrorMessage } from "./api-error.js";
import { formatMinor } from "./format.js";

const props = defineProps<{
  symbol: SymbolCode;
  bestBidMinor: number | null;
  bestAskMinor: number | null;
  submitOrder?: (request: PlaceOrderRequest) => Promise<unknown>;
}>();
const emit = defineEmits<{ submit: [request: PlaceOrderRequest] }>();

const price = ref("");
const quantity = ref("");
const submitting = ref(false);
const errorMessage = ref("");
const successMessage = ref("");
const retainedIntent = ref<{ key: string; clientOrderId: string } | null>(null);

const parsePriceMinor = (input: string): number | null => {
  // 直接按十进制字符串拆分并用 BigInt 计算，避免 Number(price) * 100 的浮点误差。
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(input)) return null;
  const [major = "0", cents = ""] = input.split(".");
  const minor = BigInt(major) * 100n + BigInt(cents.padEnd(2, "0"));
  return minor > 0n && minor <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(minor)
    : null;
};
const parseQuantity = (input: string): number | null => {
  if (!/^[1-9]\d*$/.test(input)) return null;
  const parsed = Number(input);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const priceMinor = computed(() => parsePriceMinor(price.value));
const quantityNumber = computed(() => parseQuantity(quantity.value));
const estimatedCash = computed(() =>
  priceMinor.value !== null && quantityNumber.value !== null
    ? formatMinor(BigInt(priceMinor.value) * BigInt(quantityNumber.value))
    : "--"
);

watch(
  () => props.symbol,
  () => {
    errorMessage.value = "";
    successMessage.value = "";
  }
);

const useQuote = (value: number | null): void => {
  if (value !== null) price.value = formatMinor(value).replaceAll(",", "");
};

const intentKey = (
  side: OrderSide,
  normalizedPrice: number,
  normalizedQuantity: number
): string => `${props.symbol}:${side}:${normalizedPrice}:${normalizedQuantity}`;

const clientOrderIdFor = (key: string): string => {
  if (retainedIntent.value?.key === key)
    return retainedIntent.value.clientOrderId;
  // 股票、方向、价格或数量变化代表新的下单意图，应使用新的幂等 ID。
  const clientOrderId = globalThis.crypto.randomUUID();
  retainedIntent.value = { key, clientOrderId };
  return clientOrderId;
};

const resultIsDefiniteRejection = (error: unknown): boolean =>
  error instanceof ApiClientError && error.status >= 400 && error.status < 500;

const submit = async (side: OrderSide): Promise<void> => {
  if (submitting.value) return;
  errorMessage.value = "";
  successMessage.value = "";
  const normalizedPrice = parsePriceMinor(price.value);
  if (normalizedPrice === null) {
    errorMessage.value = "限价必须大于 0，且最多两位小数。";
    return;
  }
  const normalizedQuantity = parseQuantity(quantity.value);
  if (normalizedQuantity === null) {
    errorMessage.value = "数量必须为正整数。";
    return;
  }
  const key = intentKey(side, normalizedPrice, normalizedQuantity);
  const request: PlaceOrderRequest = {
    clientOrderId: clientOrderIdFor(key),
    symbol: props.symbol,
    side,
    limitPriceMinor: normalizedPrice,
    quantity: normalizedQuantity
  };
  emit("submit", request);
  if (props.submitOrder === undefined) return;
  submitting.value = true;
  try {
    await props.submitOrder(request);
    if (retainedIntent.value?.key === key) retainedIntent.value = null;
    successMessage.value = "委托已受理，等待实时数据确认。";
  } catch (error: unknown) {
    // 4xx 表示服务端明确拒绝，本次 ID 可以丢弃；网络错误/5xx 的结果可能未知，
    // 必须保留同一 ID 供用户安全重试。
    if (resultIsDefiniteRejection(error) && retainedIntent.value?.key === key) {
      retainedIntent.value = null;
    }
    errorMessage.value = commandErrorMessage(
      error,
      "下单未完成，请检查输入或网络后重试。"
    );
  } finally {
    submitting.value = false;
  }
};
</script>

<template>
  <form class="order-form" aria-labelledby="order-form-title" @submit.prevent>
    <div class="panel-heading">
      <div>
        <p class="panel-kicker">LIMIT ORDER</p>
        <h2 id="order-form-title">限价委托 · {{ symbol }}</h2>
      </div>
      <span class="order-form__badge">整股</span>
    </div>
    <div class="quote-shortcuts" aria-label="最佳报价快捷填入">
      <button
        type="button"
        class="quote-shortcut quote-shortcut--bid"
        data-action="use-best-bid"
        :disabled="bestBidMinor === null || submitting"
        @click="useQuote(bestBidMinor)"
      >
        <span>最佳买价</span
        ><strong>{{
          bestBidMinor === null ? "--" : formatMinor(bestBidMinor)
        }}</strong
        ><small>卖出可填</small>
      </button>
      <button
        type="button"
        class="quote-shortcut quote-shortcut--ask"
        data-action="use-best-ask"
        :disabled="bestAskMinor === null || submitting"
        @click="useQuote(bestAskMinor)"
      >
        <span>最佳卖价</span
        ><strong>{{
          bestAskMinor === null ? "--" : formatMinor(bestAskMinor)
        }}</strong
        ><small>买入可填</small>
      </button>
    </div>
    <div class="order-fields">
      <label for="order-price">限价（虚拟币）</label>
      <div class="input-shell">
        <span aria-hidden="true">¥</span
        ><input
          id="order-price"
          v-model="price"
          name="price"
          inputmode="decimal"
          autocomplete="off"
          placeholder="0.00"
          :disabled="submitting"
          aria-describedby="price-help"
        />
      </div>
      <small id="price-help">大于 0，最多两位小数</small>
      <label for="order-quantity">数量（股）</label>
      <div class="input-shell">
        <input
          id="order-quantity"
          v-model="quantity"
          name="quantity"
          inputmode="numeric"
          autocomplete="off"
          placeholder="100"
          :disabled="submitting"
        /><span aria-hidden="true">股</span>
      </div>
    </div>
    <div class="order-estimate" aria-live="polite">
      <span data-estimate="buy"
        >买入预估冻结 <strong>¥ {{ estimatedCash }}</strong></span
      >
      <span data-estimate="sell"
        >卖出预估冻结 <strong>{{ quantityNumber ?? "--" }} 股</strong></span
      >
    </div>
    <p
      v-if="errorMessage"
      class="inline-alert inline-alert--error"
      role="alert"
    >
      {{ errorMessage }}
    </p>
    <p
      v-else-if="successMessage"
      class="inline-alert inline-alert--success"
      role="status"
    >
      {{ successMessage }}
    </p>
    <div class="order-actions">
      <button
        type="button"
        class="trade-button trade-button--buy"
        data-action="buy"
        :disabled="submitting"
        @click="submit('BUY')"
      >
        {{ submitting ? "提交中…" : "买入" }}
      </button>
      <button
        type="button"
        class="trade-button trade-button--sell"
        data-action="sell"
        :disabled="submitting"
        @click="submit('SELL')"
      >
        {{ submitting ? "提交中…" : "卖出" }}
      </button>
    </div>
    <p class="order-form__disclaimer">
      模拟交易 · 委托提交后以服务端撮合结果为准
    </p>
  </form>
</template>
