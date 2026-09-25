import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Resolve `@jevshield/core` straight to its TypeScript source so the workbench
 * gets hot reload on engine changes without a build step. Core's own `.js`
 * relative specifiers resolve to `.ts` via Vite's TypeScript handling.
 */
const coreEntry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@jevshield/core": coreEntry,
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // The Rust shell rebuilds itself; don't let the dev server watch it.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 2_000,
    // Monaco, recharts and dockview are large and independent; splitting them
    // keeps the workbench entry chunk small and lets the webview parse them in
    // parallel.
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: "monaco", test: /node_modules[\\/]monaco-editor/ },
            {
              name: "recharts",
              test: /node_modules[\\/](recharts|victory-vendor|d3-)/,
            },
            { name: "dockview", test: /node_modules[\\/]dockview/ },
            { name: "genai", test: /node_modules[\\/]@google[\\/]/ },
          ],
        },
      },
    },
  },
});
