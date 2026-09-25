import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import type { Environment } from "monaco-editor";
// monaco-editor ships no `exports` wildcard for `esm/*`; its map prefixes `./*`
// onto `./esm/vs/*`, so these specifiers are already relative to the esm root.
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import jsonWorker from "monaco-editor/language/json/json.worker.js?worker";

export const MONACO_THEME = "jevshield-abyss";

let configured = false;

/**
 * `@monaco-editor/react` loads Monaco from a CDN by default, which is wrong for
 * an offline-capable desktop IDE. We hand the loader the locally bundled
 * instance and register the JSON language worker explicitly.
 */
export function ensureMonaco(): void {
  if (configured) return;
  configured = true;

  const environment: Environment = {
    getWorker: (_workerId, label) =>
      label === "json" ? new jsonWorker() : new editorWorker(),
  };

  const scope = globalThis as typeof globalThis & {
    MonacoEnvironment?: Environment;
  };
  scope.MonacoEnvironment = environment;

  monaco.editor.defineTheme(MONACO_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "string.key.json", foreground: "5eead4" },
      { token: "string.value.json", foreground: "cbd5e1" },
      { token: "number", foreground: "fbbf24" },
      { token: "keyword.json", foreground: "a78bfa" },
      { token: "delimiter", foreground: "64748b" },
    ],
    colors: {
      "editor.background": "#0b0e14",
      "editor.foreground": "#cbd5e1",
      "editorLineNumber.foreground": "#3f4b60",
      "editorLineNumber.activeForeground": "#94a3b8",
      "editor.selectionBackground": "#1d3f4a",
      "editor.lineHighlightBackground": "#10141c",
      "editorCursor.foreground": "#2dd4bf",
      "editorIndentGuide.background1": "#1d2430",
      "editorWidget.background": "#10141c",
      "editorWidget.border": "#232b38",
      "scrollbarSlider.background": "#232b3880",
      "scrollbarSlider.hoverBackground": "#313c4e99",
    },
  });

  loader.config({ monaco });
}
