<script setup lang="ts">
import type { AccountSnapshot, SymbolCode } from "@paper/shared";
import { computed } from "vue";

import { formatMinor } from "./format.js";

const props = defineProps<{
  account: AccountSnapshot | null;
  symbol: SymbolCode;
}>();
const position = computed(
  () =>
    props.account?.positions[props.symbol] ?? {
      availableQuantity: 0,
      frozenQuantity: 0
    }
);
</script>

<template>
  <aside class="account-panel panel" aria-labelledby="account-title">
    <div class="panel-heading">
      <div>
        <p class="panel-kicker">PORTFOLIO</p>
        <h2 id="account-title">资产概览</h2>
      </div>
    </div>
    <template v-if="account">
      <dl class="metric-list">
        <div class="metric metric--primary">
          <dt>可用资金</dt>
          <dd>¥ {{ formatMinor(account.cashAvailableMinor) }}</dd>
        </div>
        <div class="metric">
          <dt>冻结资金</dt>
          <dd>¥ {{ formatMinor(account.cashFrozenMinor) }}</dd>
        </div>
      </dl>
      <div class="position-card">
        <div>
          <span>选中持仓</span><strong>{{ symbol }}</strong>
        </div>
        <dl>
          <div>
            <dt>可用</dt>
            <dd>可用 {{ position.availableQuantity }} 股</dd>
          </div>
          <div>
            <dt>冻结</dt>
            <dd>冻结 {{ position.frozenQuantity }} 股</dd>
          </div>
        </dl>
      </div>
      <p class="account-panel__note">账户数据以服务端实时快照为准</p>
    </template>
    <p v-else class="empty-state">正在同步账户数据…</p>
  </aside>
</template>
