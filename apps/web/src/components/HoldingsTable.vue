<script setup lang="ts">
import { SYMBOLS, type AccountSnapshot } from "@paper/shared";

defineProps<{ account: AccountSnapshot | null }>();
</script>

<template>
  <div class="table-scroll">
    <table aria-label="全部持仓">
      <caption class="sr-only">
        当前用户全部股票持仓
      </caption>
      <thead>
        <tr>
          <th scope="col">股票</th>
          <th scope="col">可用数量</th>
          <th scope="col">冻结数量</th>
          <th scope="col">总持仓</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="account === null">
          <td colspan="4"><p class="table-empty">正在同步持仓…</p></td>
        </tr>
        <tr v-for="symbol in SYMBOLS" v-else :key="symbol">
          <td>
            <strong>{{ symbol }}</strong>
          </td>
          <td>{{ account.positions[symbol].availableQuantity }}</td>
          <td>{{ account.positions[symbol].frozenQuantity }}</td>
          <td>
            {{
              account.positions[symbol].availableQuantity +
              account.positions[symbol].frozenQuantity
            }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
