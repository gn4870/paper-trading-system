import type {
  BootstrapResponse,
  LoginRequest,
  RegisterRequest
} from "@paper/shared";
import { defineStore } from "pinia";
import { reactive, toRef } from "vue";

import { ApiClientError, HttpClient } from "../api/http-client.js";

export type AuthStatus = "unknown" | "authenticated" | "anonymous";
export type AuthenticatedUser = BootstrapResponse["user"];

export interface AuthHttpClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export interface AuthStore {
  user: AuthenticatedUser | null;
  status: AuthStatus;
  restore: () => Promise<void>;
  register: (input: RegisterRequest) => Promise<void>;
  login: (input: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
  invalidate: () => void;
}

interface AuthResponse {
  user: AuthenticatedUser;
}

const invalidatesSession = (error: unknown): boolean =>
  error instanceof ApiClientError && error.status === 401;

export const createAuthStoreHarness = (http: AuthHttpClient): AuthStore => {
  let restorePromise: Promise<void> | undefined;
  const state = reactive<AuthStore>({
    user: null,
    status: "unknown",
    restore: async () => {
      if (state.status !== "unknown") return;
      if (restorePromise !== undefined) return restorePromise;
      restorePromise = (async () => {
        try {
          const bootstrap = await http.get<BootstrapResponse>("/api/bootstrap");
          state.user = bootstrap.user;
          state.status = "authenticated";
        } catch {
          state.user = null;
          state.status = "anonymous";
        }
      })();
      return restorePromise;
    },
    register: async (input) => {
      const response = await http.post<AuthResponse>(
        "/api/auth/register",
        input
      );
      state.user = response.user;
      state.status = "authenticated";
    },
    login: async (input) => {
      const response = await http.post<AuthResponse>("/api/auth/login", input);
      state.user = response.user;
      state.status = "authenticated";
    },
    logout: async () => {
      try {
        await http.post<void>("/api/auth/logout");
        state.user = null;
        state.status = "anonymous";
      } catch (error: unknown) {
        if (invalidatesSession(error)) {
          state.user = null;
          state.status = "anonymous";
        }
        throw error;
      }
    },
    invalidate: () => {
      state.user = null;
      state.status = "anonymous";
    }
  });
  return state;
};

export const useAuthStore = defineStore("auth", () => {
  const harness = createAuthStoreHarness(new HttpClient());
  return {
    user: toRef(harness, "user"),
    status: toRef(harness, "status"),
    restore: harness.restore,
    register: harness.register,
    login: harness.login,
    logout: harness.logout,
    invalidate: harness.invalidate
  };
});
