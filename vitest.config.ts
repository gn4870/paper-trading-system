import vue from "@vitejs/plugin-vue";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "e2e/**", "**/dist/**"]
  }
});
