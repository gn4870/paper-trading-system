<script setup lang="ts">
import type { PricePoint, SymbolCode } from "@paper/shared";
import { computed } from "vue";

const props = defineProps<{ symbol: SymbolCode; points: PricePoint[] }>();
const WIDTH = 320;
const HEIGHT = 100;
const PADDING = 6;

const polylinePoints = computed(() => {
  if (props.points.length === 0) return "";
  const values = props.points.map((point) => point.priceMinor);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min;
  return props.points
    .map((point, index) => {
      const x =
        props.points.length === 1
          ? WIDTH / 2
          : PADDING +
            index * ((WIDTH - PADDING * 2) / (props.points.length - 1));
      const y =
        spread === 0
          ? HEIGHT / 2
          : PADDING +
            ((max - point.priceMinor) / spread) * (HEIGHT - PADDING * 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
});
const description = computed(() =>
  props.points.length === 0
    ? "暂无走势数据"
    : `${props.points.length} 个价格点，展示最近 60 秒价格走势`
);
</script>

<template>
  <svg
    class="sparkline"
    viewBox="0 0 320 100"
    role="img"
    preserveAspectRatio="none"
  >
    <title>{{ symbol }} 最近 60 秒走势</title>
    <desc>{{ description }}</desc>
    <line x1="0" y1="50" x2="320" y2="50" class="sparkline__baseline" />
    <polyline
      v-if="points.length"
      :points="polylinePoints"
      class="sparkline__line"
      fill="none"
    />
    <circle
      v-if="points.length === 1"
      cx="160"
      cy="50"
      r="3"
      class="sparkline__point"
    />
    <text
      v-if="points.length === 0"
      x="160"
      y="54"
      text-anchor="middle"
      class="sparkline__empty"
    >
      暂无走势
    </text>
  </svg>
</template>
