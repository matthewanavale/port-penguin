import { defineConfig } from "vitest/config";
import { swPlugin } from "./src/sw/swPlugin";

export default defineConfig({
  // Writes dist/sw.js with the cache name and the asset list (D10).
  plugins: [swPlugin()],
  test: {
    environment: "node",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.ts"],
  },
});
