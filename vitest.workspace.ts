import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "./apps/web/vite.config.ts",
  {
    test: {
      name: "shared",
      include: ["packages/shared/src/**/*.test.ts"]
    }
  }
]);
