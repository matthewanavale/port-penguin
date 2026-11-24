import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["src/legacy/**", "src/test/golden/**", "dist/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The service worker template: worker globals, and the two placeholders
    // that the build fills in (D10).
    files: ["src/sw/sw.template.js"],
    languageOptions: {
      globals: {
        self: "readonly",
        caches: "readonly",
        fetch: "readonly",
        __CACHE__: "readonly",
        __ASSETS__: "readonly",
      },
    },
  },
);
