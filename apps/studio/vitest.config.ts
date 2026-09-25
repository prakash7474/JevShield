import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * The engine layer (`src/engine`, `src/lib`) is deliberately DOM-free, so it
 * runs under a plain Node environment without jsdom.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@jevshield/core": fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
