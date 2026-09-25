import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// dockview's stylesheet is imported before ours so the theme variable overrides
// in index.css win.
import "dockview-react/dist/styles/dockview.css";
import "./index.css";

import { App } from "./App";
import { ensureMonaco } from "./lib/monacoSetup";

/**
 * Vite does not define `process` in the browser. JevShield core only reads
 * `process.env` as a fallback when no explicit key is passed, and the studio
 * always passes explicit keys — this shim just makes a stray read harmless
 * instead of a `ReferenceError`.
 */
const globalScope = globalThis as {
  process?: { env: Record<string, string | undefined> };
};
globalScope.process ??= { env: {} };

ensureMonaco();

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root is missing from index.html.");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
