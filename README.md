# @jevshield/core

Enterprise TypeScript SDK that **patches and wraps** TypeSafe AI's [Jev](https://docs.typesafe.ai/api)
System One model (`POST https://api.typesafe.ai/v1/systemone`).

Jev returns *typed probabilistic decisions* (`noul`, `choice`, `score`) in ~100 ms instead of
generated text. JevShield keeps that speed and determinism, and closes the architectural gaps
around it.

```bash
npm install @jevshield/core
```

Requires Node 20+.

## The five weaknesses this SDK patches

| # | Jev's limitation | How JevShield patches it |
|---|---|---|
| 1 | Cannot compute math, dates or item counts | `src/enricher/stateEnricher.ts` — deterministic pre-processor deriving elapsed days, item counts, min/max/mean/median and pairwise date deltas into a `__jevshield` block inside the state |
| 2 | Hard limits: 255 choice options, 2–10 score levels, 32k/64k tokens | `src/client/schemas.ts` validates questions *before* the request is spent; the enricher truncates oversized state deterministically and reports exactly how |
| 3 | Vulnerable to prompt injection and literal-text bias | `src/security/dualGuardrail.ts` injects a parallel adversarial `noul` question into the *same* round trip and blocks/flags/escalates on its verdict |
| 4 | Produces decisions, not prose | `src/renderer/decisionRenderer.ts` renders typed decisions into deterministic prose (no model call, no randomness) |
| 5 | Single-vendor cloud lock-in | `src/router/cascadeRouter.ts` + `src/fallback/generativeFallback.ts` escalate to Gemini Flash, Claude, or any OpenAI-compatible endpoint when confidence is too low |

## Quickstart

```ts
import { JevShield } from "@jevshield/core";

const shield = new JevShield({
  // defaults to process.env.TYPESAFE_API_KEY
  confidenceThreshold: 0.6,
  fallback: { provider: "gemini" },       // needs GEMINI_API_KEY
});

const result = await shield.decide({
  state: {
    message: "Help! My payouts have been failing for 3 days.",
    created_at: "2026-09-20T12:00:00.000Z",
    failed_payouts: [120, 80, 45],
  },
  questions: {
    is_urgent: { type: "noul", instructions: "Does this convey urgency?" },
    department: {
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: {
        billing: "Payments, invoicing, refunds",
        technical: "Bugs, outages, integrations",
        sales: "Pricing, upgrades, new accounts",
      },
    },
    frustration: {
      type: "score",
      instructions: "How frustrated is the customer?",
      criteria: ["Calm", "Frustrated", "Very angry"],
    },
  },
});

result.decisions;   // JevDecision[] — normalized, no branching on answer.type
result.confidence;  // lowest confidence across decisions
result.security;    // injection verdict from the injected guardrail
result.prose;       // deterministic prose rendering
result.enrichedState["__jevshield"];
// {
//   generated_at: "2026-09-25T12:00:00.000Z",
//   dates: { created_at: { elapsed_days: 5, ... } },
//   counts: { failed_payouts: 3 },
//   stats: { failed_payouts: { sum: 245, mean: 81.666667, ... } },
//   date_differences: {},
//   custom: {},
//   truncation: { applied: false, strategy: "none", ... },
// }
```

### Dry-run the pipeline

```ts
import { enrichState } from "@jevshield/core/enricher";
import { injectSecurityGate } from "@jevshield/core/security";

const enriched = enrichState(rawState, undefined, { now: new Date("2026-09-25T12:00:00Z") });
const { questions } = injectSecurityGate(myQuestions);
```

### Gemini cascade router

Jev answers bounded questions; Gemini writes the prose. `GeminiCascadeRouter` is the only
place in the SDK that talks to `@google/genai`.

```ts
import { GeminiCascadeRouter } from "@jevshield/core/router";

const router = new GeminiCascadeRouter(process.env.GEMINI_API_KEY, {
  model: "gemini-2.5-flash",   // or GEMINI_MODEL
  temperature: 0.2,
  maxOutputTokens: 1024,
  timeoutMs: 30_000,
});

const text = await router.generateText("Draft a refund policy.", "Be concise.");

// When you also want the model id and token usage:
const { text: draft, model, usage } = await router.generate(prompt, systemInstruction);
```

`generateText` resolves to `""` — never `null` — when the model produced no text, so callers
can branch without a null check. Provider failures surface as `JevFallbackError` with the
original error attached as `cause`, keeping retry decisions consistent with the rest of the SDK.

When `JevShield` has a fallback configured, the cascade runs automatically: Jev resolves the
typed decision, and only if the lowest confidence falls below `confidenceThreshold` does the
router generate prose — which then becomes `result.prose`.

```ts
const shield = new JevShield({
  confidenceThreshold: 0.6,
  fallback: { provider: "gemini", apiKey: process.env.GEMINI_API_KEY },
});

const result = await shield.decide({ state, questions });
result.prose;     // Gemini prose when Jev was unsure, deterministic rendering otherwise
result.fallback;  // undefined unless escalation actually happened
```

## Options

| Option | Default | Purpose |
|---|---|---|
| `apiKey` | `process.env.TYPESAFE_API_KEY` | TypeSafe credential |
| `baseUrl` | `process.env.TYPESAFE_BASE_URL` → `https://api.typesafe.ai` | Override for proxies/gateways |
| `model` | `process.env.JEVD_MODEL` → `jev-latest` | Model id or alias |
| `timeoutMs` | `60_000` | Per-request HTTP timeout |
| `retryConfig` | 3 retries, 500 ms → 8 s, ×2 | Only retries 429/529/5xx/transport; 401 and 422 fail fast |
| `confidenceThreshold` | `process.env.JEVD_CONFIDENCE_THRESHOLD` → `0.6` | Escalation trigger |
| `fallbackEndpoint` | — | Shorthand for `fallback: { provider: "custom", endpoint }` |
| `fallback` | disabled | `{ provider: "gemini" \| "anthropic" \| "custom", apiKey?, model?, ... }` or `false` |
| `enricher` | enabled | `EnrichStateOptions` or `false` |
| `guardrails` | enabled | `SecurityGateOptions` (`key`, `instructions`, `criteria`, `threshold`, `onConflict`) or `false` |
| `onInjection` | `"throw"` | `"throw"` \| `"flag"` \| `"fallback"` |
| `preferFallbackProse` | `true` | Use fallback text as `result.prose` when available |
| `httpClient` | — | Inject an `AxiosInstance` (tests, custom transports) |

## Design decisions worth knowing

**Discriminants are lowercase.** The wire protocol uses `"noul" | "choice" | "score"`.
PascalCase on the wire is rejected with a 422, so the types are lowercase and the
injected guardrail question is `{ "type": "noul", ... }`.

**One round trip, not two.** Jev evaluates every question against the same state in
parallel, so the adversarial check costs one extra answer rather than a second HTTP call.
The guardrail answer is stripped from `result.decisions` (it is still visible in
`result.answers` and `result.security`).

**Determinism is a feature.** `enrichState` takes an optional `now`; the same input and
reference instant always produce byte-identical output (keys are sorted before
serializing). Prose rendering is templated, never model-generated, so the same decisions
always render the same text.

**Escalation is lazy and non-fatal.** The fallback provider is resolved on first need, so
a missing `GEMINI_API_KEY` never breaks construction — and a failed fallback call degrades
to the deterministic rendering with a logged warning.

**One place talks to Gemini.** `@google/genai` is a direct dependency and every Gemini call
goes through `GeminiCascadeRouter` — the fallback provider delegates to it instead of
duplicating request construction. `@anthropic-ai/sdk` stays optional and loads lazily.

## Repository layout

This repository is an npm workspace:

| Path | Package | What it is |
|---|---|---|
| `/` | `@jevshield/core` | The engine — this README |
| `apps/studio` | `@jevshield/studio` | **JevShield Studio** — a Tauri v2 + React desktop IDE for designing, auditing and replaying Jev decision pipelines |

```bash
npm install          # installs both workspaces
npm test             # core unit tests
npm run studio:dev   # launch the Studio workbench
```

See [`apps/studio/README.md`](apps/studio/README.md) for the IDE, its panels and its
known limitations.

## Module map

```
src/
├── index.ts                       JevShield facade + public exports
├── types/index.ts                 wire types, limits, options
├── errors.ts                      typed error hierarchy
├── client/jevClient.ts            axios + p-retry transport
├── client/schemas.ts              zod validation + hard-limit enforcement
├── enricher/stateEnricher.ts      deterministic derivation + truncation
├── security/dualGuardrail.ts      adversarial question + verdict
├── router/cascadeRouter.ts        Gemini Flash text generation (@google/genai)
├── fallback/generativeFallback.ts Gemini / Anthropic / custom endpoint
└── renderer/decisionRenderer.ts   normalization + deterministic prose
```

## Development

```bash
npm run typecheck   # tsc
npm test            # vitest
npm run build       # emit dist/ + .d.ts
```

## License

Apache-2.0
