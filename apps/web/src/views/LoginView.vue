<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";

import { useAuthStore } from "../stores/auth-store.js";
import { executableErrorMessage, validateCredentials } from "./auth-form.js";

const auth = useAuthStore();
const router = useRouter();
const username = ref("");
const password = ref("");
const errorMessage = ref("");
const submitting = ref(false);

const submit = async (): Promise<void> => {
  if (submitting.value) return;
  const input = {
    username: username.value.trim().toLowerCase(),
    password: password.value
  };
  errorMessage.value = validateCredentials(input) ?? "";
  if (errorMessage.value) return;
  submitting.value = true;
  try {
    await auth.login(input);
    await router.replace({ name: "trade" });
  } catch (error: unknown) {
    errorMessage.value = executableErrorMessage(error);
  } finally {
    submitting.value = false;
  }
};
</script>

<template>
  <main class="auth-page">
    <section class="auth-card" aria-labelledby="login-title">
      <p class="eyebrow">PAPER TRADING TERMINAL</p>
      <h1 id="login-title">登录交易台</h1>
      <p class="muted">使用模拟账户查看市场并管理委托。</p>
      <form class="auth-form" @submit.prevent="submit">
        <label>
          用户名
          <input
            v-model="username"
            autocomplete="username"
            maxlength="32"
            required
          />
        </label>
        <label>
          密码
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            maxlength="72"
            required
          />
        </label>
        <p v-if="errorMessage" class="form-error" role="alert">
          {{ errorMessage }}
        </p>
        <button type="submit" :disabled="submitting">
          {{ submitting ? "正在登录…" : "登录" }}
        </button>
      </form>
      <p class="auth-switch">
        还没有账户？<RouterLink to="/register">开户注册</RouterLink>
      </p>
    </section>
  </main>
</template>
