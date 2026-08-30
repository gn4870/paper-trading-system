<script setup lang="ts">
import { computed } from "vue";

import type { ConnectionStatus } from "../stores/realtime-store.js";

const props = defineProps<{ status: ConnectionStatus }>();
const labels: Record<ConnectionStatus, string> = {
  idle: "尚未连接",
  connecting: "正在连接",
  live: "实时连接正常",
  reconnecting: "连接中断，正在重连",
  offline: "当前离线"
};
const label = computed(() => labels[props.status]);
</script>

<template>
  <span
    class="connection-status"
    :class="`connection-status--${status}`"
    role="status"
    :aria-label="`WebSocket：${label}`"
  >
    <span class="connection-status__indicator" aria-hidden="true"></span>
    <span>{{ label }}</span>
  </span>
</template>
