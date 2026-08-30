import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.test.ts"],
    languageOptions: {
      globals: {
        crypto: "readonly",
        describe: "readonly",
        expect: "readonly",
        it: "readonly"
      }
    }
  }
);
