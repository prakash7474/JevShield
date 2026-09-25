# JevShield Studio

A cross-platform visual IDE and debugger for Jev decision pipelines, wrapping the
`@jevshield/core` engine in a Tauri v2 + React desktop shell.

Design state, configure question sets, inspect calibrated probability distributions, trace a
request through the cascade, and replay historical decision traces.

---

## Running it

```bash
# from the repository root — installs the workspace (core + studio)
npm install

# web preview at http://localhost:1420 (works immediately in demo mode)
npm run studio:dev

# desktop shell (requires a Rust toolchain — see Prerequisites)
npm run studio:tauri dev

# checks
npm run studio:typecheck
npm test -w @jevshield/studio
npm run studio:build
```

### Prerequisites for the desktop shell

The React workbench runs with just Node 20+. The **Tauri shell additionally needs**:

- Rust 1.77.2+ (`rustup`) and `cargo`
- Platform build deps: WebView2 (Windows) / `webkit2gtk` + `libappindicator` (Linux) / Xcode CLT (macOS)
- Icons before bundling: `npm run tauri icon path/to/icon.png` — `tauri.conf.json` ships no
  `bundle.icon` entry, so `tauri dev` works but `tauri build` needs one.

## Demo mode vs live mode

The IDE is fully usable the moment it starts, with no credentials.

| | Demo mode (default) | Live mode |
|---|---|---|
| Trigger | no `TYPESAFE_API_KEY`, or **Force demo mode** in Settings | `TYPESAFE_API_KEY` present and demo mode off |
| Jev | `simulateJevResponse()` — seeded PRNG, real API-shaped answers | `POST https://api.typesafe.ai/v1/systemone` |
| Security gate | lexical injection heuristic | Jev's own adversarial `noul` answer |
| Gemini | `simulateGeminiProse()` | `GeminiCascadeRouter` → `gemini-2.5-flash` |

Demo mode is not a stub UI: it emits a **structurally identical `JevResponse`**, so the
enricher, guardrail, chunker, confidence router, renderer and trajectory log all run the same
code path as production. Only the two provider calls are swapped out.

Load a sample from the toolbar:

- **Sample** — realistic support-ticket payload (dates, arrays, numeric arrays)
- **Injection** — same shape with an embedded prompt-injection attempt, to exercise the gate
- **Oversized** — a 300-option Choice question to exercise the tree chunker

## Workspace panels

| Panel | What it does |
|---|---|
| **State & Enrichment** (left top) | Monaco JSON editor over the raw payload. The preview runs the *real* `enrichState` pre-processor, showing derived dates, item counts, numeric aggregates, cross-field day deltas, and any truncation that would be applied. |
| **Question Set** (left bottom) | Graphical builder for `Noul` / `Choice` / `Score` questions. Prevents a 422 before it happens: 255-option ceiling, 2–10 Score levels, missing rubrics. The **Security firewall** switch toggles the auto-injected `__jevshield_adversarial_check`. |
| **Cascade Simulator** (centre) | Interactive execution canvas: Raw State → State Enricher → Dual Security Gate → Tree Chunker → Confidence Threshold → Cascade Action. Every node is clickable and reports its own status, duration and payload. |
| **Probability Inspector** (right) | Recharts distribution for every answer with its uniform baseline marked, plus draggable cascade / auto-act thresholds and a three-zone band showing where Auto-Act, Human Escalation and Generative Cascade trigger. |
| **Trajectory Log** (bottom) | Append-only run history with `jevLatencyMs` vs `geminiLatencyMs`, token counts, estimated cost, and per-row **Replay** / **Fork** (load the snapshot back into the editors without executing). |

The dock layout is persisted per machine; **Reset layout** in the trajectory toolbar clears it.

## Architecture

```
apps/studio/src/
├── engine/                 DOM-free pipeline layer (unit tested)
│   ├── engineClient.ts     runs the six stages, live or simulated
│   ├── chunker.ts          splits >255-option Choice questions, merges distributions
│   ├── demoData.ts         seeded Jev simulator + injection heuristic + prose simulator
│   ├── enrichmentPreview.ts  backs the live pre-processor preview
│   ├── samples.ts          bundled payloads and question sets
│   ├── probability.ts      shared confidence / normalization helpers
│   └── pricing.ts          placeholder token rates for the cost column
├── store/useStudioStore.ts zustand store, localStorage-persisted
├── components/ui/          shadcn-style primitives (Radix + CVA + tailwind-merge)
├── components/panels/      the five workbench panels
├── lib/                    cn, formatting, Monaco bootstrap, Tauri detection
└── App.tsx                 dockview layout + persisted arrangement
```

`@jevshield/core` is consumed **from source** via a Vite alias and a TS `paths` entry, so
engine changes hot-reload with no build step. Core's own `.js` relative specifiers resolve to
`.ts` through Vite's TypeScript handling.

### Why the engine layer is separate

`src/engine` imports nothing from React or the DOM. That is deliberate: it means the routing,
chunking and security logic is verifiable under plain Node (`npm test -w @jevshield/studio`,
19 tests) rather than only by clicking around the UI.

## Corrections to the original spec

Three items in the brief did not match the current ecosystem:

1. **`react-dockview` does not exist on npm.** The real package is **`dockview-react`** (v8.3.1),
   which re-exports `dockview-core`. This app uses that.
2. **Tailwind is v4**, which is CSS-first: there is no `tailwind.config.js` or `postcss.config.js`.
   Design tokens live in `src/index.css` under `@theme`, and the plugin is `@tailwindcss/vite`.
3. **`lucide-react` v1 renamed its icons.** `Trash2 → Trash`, `Loader2 → LoaderCircle`,
   `BarChart3 → ChartColumn`, `CheckCircle2 → CircleCheck`, `AlertCircle → CircleAlert`,
   `History → Clock`. All icon usages here are checked against the installed package.

Also note the API discriminants are **lowercase** (`noul` / `choice` / `score`) and the option
map is `criteria` — see the core README.

## Security notes

**Credentials.** Keys live in this app's `localStorage` (the brief allowed "desktop local storage").
That is fine for a single developer's machine but is *not* secure storage. Before distributing
this to others, move them to `tauri-plugin-store` or `tauri-plugin-stronghold` and read them
through a Rust command. The modal says so in the UI.

**CSP.** `tauri.conf.json` ships `"csp": null` (the Tauri project default). For a hardened build,
set:

```
default-src 'self'; connect-src 'self' ipc: http://ipc.localhost https://api.typesafe.ai https://generativelanguage.googleapis.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:
```

Verify it against a real `tauri build` first — Monaco's workers are the usual breakage point.

**CORS.** Live mode calls `api.typesafe.ai` and `generativelanguage.googleapis.com` from the
webview. A custom-protocol Tauri origin is not same-origin with those hosts, so a strict provider
may reject the request. The integration point for fixing this properly already exists: pass a
`fetch`-backed `AxiosInstance` into `JevShield`'s `httpClient` option (or route through a Rust
command / `tauri-plugin-http`) without touching the engine.

**Cost estimates.** `src/engine/pricing.ts` holds editable placeholder rates. They are not scraped
published prices — set them to match your contract before trusting the cost column.

## Verified vs unverified

Verified in this environment:

- `tsc --noEmit` clean (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`)
- 19 engine tests passing
- `vite build` succeeds, entry chunk 352 kB with Monaco / recharts / dockview / genai split out

**Not verified:** the Rust/Tauri shell. No Rust toolchain was available here, so
`src-tauri/` is written against the Tauri v2 conventions but has never been compiled. Expect to
run `cargo check` once and possibly adjust crate versions.
