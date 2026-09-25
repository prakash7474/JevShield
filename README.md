# @jevshield/core

Enterprise TypeScript SDK that **patches and wraps** TypeSafe AI's [Jev](https://docs.typesafe.ai/api)
System One model, and bridges it to Google Gemini for text generation.

Jev (`POST https://api.typesafe.ai/v1/systemone`) returns *typed probabilistic decisions*
(`noul`, `choice`, `score`) in roughly 100 ms instead of generated prose. JevShield keeps that
speed and determinism while closing the architectural gaps around it — and escalates to a
generative model only when Jev cannot answer confidently enough.

```bash
npm install @jevshield/core
```

- **Runtime:** Node 22+ (ESM only — `p-retry@8` requires it)
- **Types:** TypeScript 5.x / 7.x, `strict` clean including `noUncheckedIndexedAccess`
- **Hard dependencies:** `axios`, `p-retry`, `zod`, `@google/genai`
- **Optional:** `@anthropic-ai/sdk` (loaded lazily, only if you use that provider)

---

## Contents

- [The five weaknesses this SDK patches](#the-five-weaknesses-this-sdk-patches)
- [Repository layout](#repository-layout)
- [Quickstart](#quickstart)
- [How each patch works](#how-each-patch-works)
- [API reference](#api-reference)
- [Environment variables](#environment-variables)
- [Design decisions and gotchas](#design-decisions-and-gotchas)
- [Development](#development)
- [Known limitations](#known-limitations)

---

## The five weaknesses this SDK patches

| # | Jev's limitation | How JevShield patches it |
|---|---|---|
| 1 | Cannot compute math, dates or item counts | `enricher/stateEnricher.ts` derives elapsed days, item counts, min/max/mean/median and pairwise date deltas into a `__jevshield` block *inside* the state, so Jev can reference them |
| 2 | Hard limits: 255 choice options, 2–10 score levels, 32k/64k tokens | `client/schemas.ts` rejects invalid questions before a request is spent; the enricher truncates oversized state deterministically and reports exactly what it did |
| 3 | Vulnerable to prompt injection and literal-text bias | `security/dualGuardrail.ts` injects a parallel adversarial `noul` question into the **same** round trip, then blocks / flags / escalates on its verdict |
| 4 | Produces decisions, not prose | `renderer/decisionRenderer.ts` renders typed decisions into deterministic prose — no model call, no randomness |
| 5 | Single-vendor cloud lock-in | `router/cascadeRouter.ts` escalates low-confidence runs to Gemini Flash; `fallback/generativeFallback.ts` adds Claude and any OpenAI-compatible endpoint |

---

## Repository layout

This repository is an npm workspace:

| Path | Package | Description |
|---|---|---|
| `/` | `@jevshield/core` | The engine — this document |
| `apps/studio` | `@jevshield/studio` | **JevShield Studio**, a Tauri v2 + React desktop IDE for designing, auditing and replaying Jev decision pipelines |

```bash
npm install          # installs both workspaces
npm test             # core unit tests
npm run studio:dev   # launch the Studio workbench
```

See [`apps/studio/README.md`](apps/studio/README.md) for the IDE.

---

## Quickstart

```ts
import { JevShield } from "@jevshield/core";

const shield = new JevShield({
  // apiKey defaults to process.env.TYPESAFE_API_KEY
  confidenceThreshold: 0.6,
  fallback: { provider: "gemini" }, // needs GEMINI_API_KEY
});

const result = await shield.decide({
  state: {
    message: "Help! My payouts have been failing for 3 days.",
    created_at: "2026-09-20T12:00:00.000Z",
    failed_payouts: [120, 80, 45],
  },
  questions: {
    is_urgent: {
      type: "noul",
      instructions: "Does this convey urgency?",
    },
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
```

### Reading the result

```ts
result.decisions;     // JevDecision[] — normalized, sorted by question id
result.confidence;    // lowest confidence across all decisions
result.lowConfidence; // confidence < confidenceThreshold
result.security;      // SecurityVerdict from the injected guardrail
result.prose;         // deterministic rendering, or fallback prose if escalated
result.fallback;      // FallbackResult, or undefined if no escalation happened
result.usage;         // { input_tokens, output_tokens }
result.model;         // concrete model, e.g. "jev-1.13.0"
result.raw;           // the untouched JevResponse

result.enrichedState?.["__jevshield"];
// {
//   schema_version: "1.0.0",
//   generated_at: "2026-09-25T12:00:00.000Z",
//   dates:           { created_at: { elapsed_days: 5, direction: "past", ... } },
//   counts:          { failed_payouts: 3 },
//   stats:           { failed_payouts: { count: 3, sum: 245, mean: 81.666667, min: 45, max: 120, median: 80 } },
//   date_differences:{},
//   custom:          {},
//   truncation:      { applied: false, strategy: "none", estimatedTokens: 164, finalTokens: 164, maxTokens: 30000 },
// }
```

`result.enrichedState` is only present when the state was a **structured object** and enrichment
was enabled. String and array states are passed through untouched (see
[Enrichment scope](#enrichment-scope)).

### Dry-run the stages

Every stage is usable on its own, which is what makes the Studio debugger possible:

```ts
import { enrichState } from "@jevshield/core/enricher";
import { injectSecurityGate } from "@jevshield/core/security";
import { toDecisions, renderDecisionReport } from "@jevshield/core";

// 1. Deterministic enrichment, reproducible for a fixed reference instant.
const enriched = enrichState(rawState, undefined, {
  now: new Date("2026-09-25T12:00:00Z"),
});

// 2. Inject the adversarial question without calling anything.
const { questions, key } = injectSecurityGate(myQuestions);

// 3. Turn a raw response into renderable decisions.
const decisions = toDecisions(response.answers, myQuestions);
console.log(renderDecisionReport(decisions));
```

### The Gemini cascade router

Jev answers bounded questions; Gemini writes the prose. `GeminiCascadeRouter` is the **only**
place in the SDK that talks to `@google/genai`.

```ts
import { GeminiCascadeRouter } from "@jevshield/core/router";

const router = new GeminiCascadeRouter(process.env.GEMINI_API_KEY, {
  model: "gemini-2.5-flash", // or GEMINI_MODEL
  temperature: 0.2,
  maxOutputTokens: 1024,
  timeoutMs: 30_000,
});

// Just the text (never null — resolves to "" when the model produced nothing).
const text = await router.generateText("Draft a refund policy.", "Be concise.");

// When you also want the model id and token usage.
const { text: draft, model, usage } = await router.generate(prompt, systemInstruction);
```

Provider failures surface as `JevFallbackError` with the original error attached as `cause`, so
retry decisions stay consistent with the rest of the SDK. `router.client` exposes the underlying
`GoogleGenAI` instance for SDK features not surfaced here, and `router.model` reports the resolved
model id.

When `JevShield` has a fallback configured the cascade runs automatically: Jev resolves the typed
decision, and only if the lowest confidence falls below `confidenceThreshold` does the router
generate prose, which then becomes `result.prose`.

---

## How each patch works

### 1. Deterministic state enrichment

`enrichState(rawState, customCalculators?, options?)` deep-walks the payload and adds a single
`__jevshield` key. It never mutates your input.

What it derives:

| Derivation | Detection rule |
|---|---|
| Dates | ISO-8601 strings (the only string format trusted), plus numbers on date-like keys (`at`, `date`, `time`, `timestamp`, `created`, `updated`, `expires`, `expiry`, `start`, `end`, `deadline`, `due`) interpreted as epoch seconds or milliseconds within a plausible 2001–2100 window |
| Per-date facts | `iso`, `elapsed_days`, `elapsed_hours`, `elapsed_seconds`, `direction` (`past` / `future` / `now`) |
| Counts | Length of every array, keyed by dotted path (`items`, `customer.tags`, `events[0].tags`) |
| Statistics | For arrays that are *entirely* numeric: `count`, `sum`, `min`, `max`, `mean`, `median` |
| Cross-field deltas | Signed days between every pair of date fields, keyed `"created_at->updated_at"` (full matrix up to 20 date fields, then anchored to the earliest) |
| Custom calculators | Whatever your functions return, namespaced under `custom` so they cannot clobber derived facts |

Custom calculators take `(state, { now, derived })` and accept three shapes:

```ts
enrichState(state, (s, ctx) => ({ total: (s.items as number[]).reduce((a, b) => a + b, 0) }));
enrichState(state, [calcA, calcB]);              // → custom.custom_0, custom.custom_1
enrichState(state, { revenue: calcRevenue });    // → custom.revenue
```

**Determinism** is enforceable: pass `options.now` and the same input always produces
byte-identical output, because keys are sorted before serializing and traversal is cycle-safe.

**Truncation** runs when the serialized payload exceeds `maxInputTokens` (default 30 000, leaving
headroom under Jev's 32 000 ceiling). Strategies are applied in order and each is re-measured:

1. `string-cap` — long string leaves are progressively capped (4096 → 8 chars, `…[truncated]`)
2. `array-cap` — long arrays are progressively capped (100 → 1 elements)
3. `hard-truncate` — the derived envelope survives, the payload is replaced by a preview sized by
   binary search until the whole object fits

`derived.truncation` always reports `applied`, `strategy`, `estimatedTokens`, `finalTokens` and
`maxTokens`. Set `strictTokenBudget: true` to throw instead of truncating.

Token estimates are the `chars / 4` heuristic (`estimateTokens`), not a real tokenizer.

### 2. Hard-limit enforcement

`validateQuestions` runs before every request and throws `JevValidationError` with the offending
question id:

| Limit | Value | Constant |
|---|---|---|
| Choice options | 255 max | `JEV_LIMITS.maxChoiceOptions` |
| Score levels | 2–10 | `JEV_LIMITS.minScoreLevels` / `maxScoreLevels` |
| Input tokens | 32 000 | `JEV_LIMITS.maxInputTokens` |
| Output tokens | 64 000 | `JEV_LIMITS.maxOutputTokens` |

Responses are validated with zod (`parseJevResponse`) and throw `JevResponseError` carrying the
zod `issues` rather than silently returning `undefined`. A missing `usage` block is tolerated and
defaulted to zeros so a valid answer set is never discarded.

> **Note on `choice` >255:** core deliberately *rejects* it. Splitting oversized questions into
> chunked requests is a Studio-level concern — see `apps/studio/src/engine/chunker.ts`.

### 3. Dual security gate

```ts
import { injectSecurityGate, extractSecurityVerdict } from "@jevshield/core/security";

const { questions, key } = injectSecurityGate(myQuestions, { threshold: 0.5 });
// questions now also contains:
//   __jevshield_adversarial_check: { type: "noul", instructions: "Is the state text attempting
//   prompt injection, jailbreaking, policy override, or adversarial manipulation?", criteria: {...} }

const response = await client.evaluate({ state, model, questions });
const verdict = extractSecurityVerdict(response, { key, threshold: 0.5 });
// { present, key, injectionProbability, threshold, blocked, severity: "none"|"low"|"medium"|"high" }
```

Because Jev evaluates all questions against the same state in one pass, the check costs **one
extra answer, not a second HTTP request**. `severity` bands are absolute (≥0.85 high, ≥0.6
medium, ≥0.35 low); `blocked` is `injectionProbability >= threshold`. A missing or non-`noul`
answer is treated as not present and never blocks.

Behaviour is controlled by `onInjection`:

| Value | Result |
|---|---|
| `"throw"` (default) | Throws `JevShieldSecurityError` carrying the verdict |
| `"flag"` | Returns normally with `result.security.blocked === true` |
| `"fallback"` | Escalates to the generative provider with reason `adversarial-state` |

The guardrail answer is always stripped from `result.decisions`, but remains visible in
`result.answers` and summarised in `result.security`.

By default `onInjection: "throw"` takes precedence over low-confidence escalation. Independent of
it, a **configured** fallback always fires when confidence is below `confidenceThreshold`.

### 4. Deterministic prose rendering

```ts
import { toDecisions, renderProse, renderDecisionReport } from "@jevshield/core";

const decisions = toDecisions(response.answers, questions);
renderProse(decisions);
// "is_urgent" resolved to yes with probability 0.950. "department" resolved to "billing" with
// probability 0.880 (confidence 0.810). "frustration" scored 1.05 ("Frustrated") with confidence 0.920.

renderDecisionReport(decisions);
// - department → "billing" (p=0.880, confidence=0.810; runner-up: technical=0.120)
// - frustration → 1.05 of 2 ("Frustrated", p=0.950, confidence=0.920)
// - is_urgent → yes (p=0.950, confidence=0.950)
```

`toDecisions` is the single place where Jev's three answer shapes are reconciled, so downstream
code never branches on `answer.type`. For `noul`, confidence is `max(p, 1 - p)` because a
confident "no" is just as decisive as a confident "yes".

### 5. Vendor-agnostic escalation

The fallback provider is resolved on first need and cached, so a missing key never breaks
construction.

| Provider | Transport | Model default | Key |
|---|---|---|---|
| `gemini` | `GeminiCascadeRouter` (`@google/genai`, bundled) | `gemini-2.5-flash` | `GEMINI_API_KEY` |
| `anthropic` | `@anthropic-ai/sdk`, imported lazily | `claude-sonnet-4-5` | `ANTHROPIC_API_KEY` |
| `custom` | OpenAI-compatible `POST <endpoint>` via axios | `gpt-4o-mini` | optional bearer |

Provider inference order when `provider` is omitted: explicit `provider` → `endpoint` present →
`GEMINI_API_KEY` → `ANTHROPIC_API_KEY` → `gemini`.

```ts
new JevShield({ fallback: { provider: "anthropic", model: "claude-sonnet-4-5" } });
new JevShield({ fallbackEndpoint: "https://my-gateway/v1/chat/completions" }); // → provider: "custom"
new JevShield({ fallback: false }); // explicit disable
```

A failed fallback call is logged and degrades to the deterministic rendering — it never fails the
run.

---

## API reference

### `JevShield`

```ts
new JevShield(options?: JevShieldOptions)
createShield(options?: JevShieldOptions)   // equivalent factory
```

| Member | Signature |
|---|---|
| `decide` | `(input: DecideOptions) => Promise<JevShieldResult>` |

Pipeline order: **enrich → inject guardrail → evaluate → verdict → confidence gate → escalate →
render**.

### `JevShieldOptions`

| Option | Type | Default | Purpose |
|---|---|---|---|
| `apiKey` | `string` | `process.env.TYPESAFE_API_KEY` | TypeSafe credential |
| `baseUrl` | `string` | `process.env.TYPESAFE_BASE_URL` → `https://api.typesafe.ai` | Override for proxies/gateways |
| `model` | `string` | `process.env.JEVD_MODEL` → `jev-latest` | Model id or alias |
| `timeoutMs` | `number` | `60_000` | Per-request HTTP timeout |
| `retryConfig` | `Partial<JevRetryConfig>` | see below | Retry policy |
| `confidenceThreshold` | `number` | `process.env.JEVD_CONFIDENCE_THRESHOLD` → `0.6` | Escalation trigger |
| `fallbackEndpoint` | `string` | — | Shorthand for `fallback: { provider: "custom", endpoint }` |
| `fallback` | `JevFallbackConfig \| false` | **disabled** | Generative escalation config |
| `enricher` | `EnrichStateOptions \| false` | enabled | Enrichment config |
| `guardrails` | `SecurityGateOptions \| false` | enabled | Adversarial question config |
| `onInjection` | `"throw" \| "flag" \| "fallback"` | `"throw"` | Response to a blocked state |
| `preferFallbackProse` | `boolean` | `true` | Use fallback text as `result.prose` |
| `httpClient` | `AxiosInstance` | — | Escape hatch for tests, proxies and custom transports |
| `logger` | `JevShieldLogger` | — | `debug` / `info` / `warn` / `error` |

`fallback` is opt-in: pass a config object (or `fallbackEndpoint`) to enable escalation. It is not
auto-enabled from ambient environment variables, so construction never fails on a missing key.

**`JevRetryConfig`** — `{ retries: 3, minTimeoutMs: 500, maxTimeoutMs: 8000, factor: 2,
retryOnServerErrors: true }`. Retried: `429`, `529`, `5xx` and transport failures, with
exponential backoff. `Retry-After` is captured as `retryAfterMs` on `JevRateLimitError` for
callers that want to honour it, but it does not currently override the backoff schedule. Failed
fast: `401` and `422`, plus every other `4xx` and malformed-response errors — repeating those
cannot change the answer. Set `retries: 0` to disable retrying entirely.

### `DecideOptions`

| Field | Type | Purpose |
|---|---|---|
| `state` | `JevState` (`string \| object \| unknown[]`) | Content to evaluate |
| `questions` | `JevQuestions` | The typed question map |
| `model` | `string` | Override the client model |
| `enrich` | `boolean` | Force enrichment on/off for this call |
| `guardrails` | `boolean` | Force the security gate on/off for this call |
| `renderProse` | `boolean` | Skip deterministic prose rendering (default `true`) |
| `confidenceThreshold` | `number` | Override the escalation threshold |
| `fallback` | `boolean` | Opt this call out of escalation |

### `JevShieldResult`

`{ model, usage, answers, decisions, confidence, lowConfidence, prose, security, raw }` plus
optional `enrichedState` and `fallback`.

`confidence` is the **minimum** across decisions — the conservative choice, because one weak
signal is enough to warrant escalation.

### `JevDecision`

```ts
{
  id: string;
  type: "noul" | "choice" | "score";
  value: number | string;      // noul probability, choice label, or score value
  probability?: number;        // probability of the winning outcome
  label?: string;              // "yes"/"no", choice label, or nearest score level
  confidence: number;          // normalized 0..1
  probabilities: Record<string, number>;
  answer: JevAnswer;           // the original typed answer
  question?: JevQuestion;      // joined when a question map was supplied
}
```

### `JevClient`

The transport, usable directly when you want raw Jev responses.

```ts
import { JevClient, createJevClient } from "@jevshield/core";

const client = new JevClient({ apiKey, model, timeoutMs, retryConfig, logger, httpClient });

await client.evaluate({ state, model: "jev-latest", questions }); // JevResponse
await client.decide(questions, state, { model });                  // JevResponse
client.model;                                                      // resolved model id
```

`JevClient` validates questions and the response. Defaults: base URL
`https://api.typesafe.ai`, path `/v1/systemone`, model `jev-latest`.

### Enricher API

| Export | Signature |
|---|---|
| `enrichState` | `(rawState, customCalculators?, options?) => EnrichedState` |
| `estimateTokens` | `(value: unknown) => number` — `chars / 4` |
| `stableStringify` | `(value: unknown) => string` — sorted keys, cycle-safe |
| `ENRICHMENT_KEY` | `"__jevshield"` |
| `ENRICHMENT_SCHEMA_VERSION` | `"1.0.0"` |
| `DEFAULT_MAX_INPUT_TOKENS` | `30_000` |

**`EnrichStateOptions`** — `now` (`Date | number | string`, for reproducibility),
`maxInputTokens`, `computeDateDifferences` (default `true`), `computeStats` (default `true`),
`strictTokenBudget` (default `false`).

### Security API

| Export | Purpose |
|---|---|
| `injectSecurityGate(questions, options?)` | Returns `{ questions, key, injected, question? }`. Never mutates the input. `onConflict` is `"throw"` (default), `"replace"` or `"skip"` |
| `extractSecurityVerdict(source, options?)` | Accepts a full `JevResponse` **or** a bare answers map |
| `ADVERSARIAL_CHECK_KEY` | `"__jevshield_adversarial_check"` |
| `ADVERSARIAL_CHECK_INSTRUCTIONS` / `ADVERSARIAL_CHECK_CRITERIA` | Default question text, overridable |
| `DEFAULT_INJECTION_THRESHOLD` | `0.5` |

### Router API

| Export | Purpose |
|---|---|
| `GeminiCascadeRouter` (`CascadeRouter`) | `constructor(apiKey?, options?)`, `generateText`, `generate`, `model`, `client` |
| `DEFAULT_CASCADE_MODEL` | `"gemini-2.5-flash"` |

**`CascadeRouterOptions`** — `model`, `defaultSystemInstruction`, `temperature`,
`maxOutputTokens`, `timeoutMs` (forwarded as `httpOptions.timeout`), `signal` (`AbortSignal`).

### Fallback API

| Export | Purpose |
|---|---|
| `createFallback(config?)` | Builds a `GenerativeFallback`; throws `JevShieldConfigError` on missing keys/endpoint |
| `buildFallbackPrompt(request)` | The prompt builder, exposed for inspection and tests |
| `DEFAULT_FALLBACK_MODELS` | `{ gemini, anthropic, custom }` model defaults |

### Renderer API

| Export | Signature |
|---|---|
| `normalizeAnswer` | `(id, answer, question?) => JevDecision` |
| `toDecisions` | `(answers, questions?) => JevDecision[]` — sorted by id |
| `renderDecision` | `(decision) => string` — one-line, log friendly |
| `renderDecisionReport` | `(decisions) => string` — bulleted, multi-line |
| `renderDecisionSentence` | `(decision) => string` — natural sentence |
| `renderProse` | `(decisions, { prefix? }) => string` — joins sentences |
| `overallConfidence` | `(decisions) => number` — minimum |
| `lowestConfidenceDecision` | `(decisions) => JevDecision \| undefined` |

### Validation API

| Export | Purpose |
|---|---|
| `validateQuestions(questions)` | Enforces structural shape plus the 255 / 2–10 limits; returns the same map |
| `parseJevResponse(data)` | zod-validated `JevResponse`, throws `JevResponseError` |
| `answerConfidence(answer)` | Normalized confidence for any answer shape |

### Errors

All extend `JevShieldError`, which carries `code`, `retryable` and optional `cause`.

| Class | `code` | `retryable` | Thrown when |
|---|---|---|---|
| `JevShieldError` | `JEVD_ERROR` | no | Base class; also used for enrichment failures |
| `JevShieldConfigError` | `JEVD_CONFIG` | no | Missing/invalid configuration, bad threshold, missing provider key |
| `JevTransportError` | `JEVD_TRANSPORT` | yes | Network failure or `5xx` |
| `JevAuthError` | `JEVD_AUTH` | no | `401` |
| `JevValidationError` | `JEVD_VALIDATION` | no | `422`, an invalid question, or an unsupported input |
| `JevRateLimitError` | `JEVD_RATE_LIMIT` | yes | `429` (carries `retryAfterMs`) |
| `JevOverloadedError` | `JEVD_OVERLOADED` | yes | `529` |
| `JevResponseError` | `JEVD_BAD_RESPONSE` | no | Response failed schema validation (carries `issues`) |
| `JevShieldSecurityError` | `JEVD_INJECTION` | no | The guardrail fired under `onInjection: "throw"` (carries `verdict`) |
| `JevFallbackError` | `JEVD_FALLBACK` | yes | A generative provider failed |

Internal-only codes: `JEVD_CALCULATOR`, `JEVD_ENRICHMENT_INPUT`, `JEVD_TOKEN_BUDGET`,
`JEVD_UNKNOWN`.

### Types and constants

```ts
import {
  JEV_LIMITS,                       // the four documented hard limits
  DEFAULT_RETRY_CONFIG,
  DEFAULT_CONFIDENCE_THRESHOLD,     // 0.6
  DEFAULT_INJECTION_THRESHOLD,      // 0.5
} from "@jevshield/core";

import type {
  JevQuestion, JevQuestions, JevInstructions, JevNoulCriteria,
  JevNoulQuestion, JevChoiceQuestion, JevScoreQuestion, JevQuestionType,
  JevState, JevRequestPayload,
  JevAnswer, JevAnswers, JevNoulAnswer, JevChoiceAnswer, JevScoreAnswer, JevResponse, JevUsage,
  JevDecision, JevShieldOptions, JevShieldResult, DecideOptions, JevShieldLogger,
  JevRetryConfig, JevFallbackConfig, FallbackProvider, FallbackRequest, FallbackResult,
  GenerativeFallback, FallbackReason,
  EnrichStateOptions, EnrichedState, EnrichmentDerived, CustomCalculator, CustomCalculatorContext,
  DateDerivation, NumericStats, TruncationReport, TruncationStrategy,
  SecurityGateOptions, SecurityVerdict,
  CascadeRouterOptions, CascadeGeneration,
  JevErrorBody,
} from "@jevshield/core";
```

### Subpath exports

| Specifier | Contents |
|---|---|
| `@jevshield/core` | Everything |
| `@jevshield/core/types` | Wire types, limits, option interfaces |
| `@jevshield/core/enricher` | `enrichState`, `estimateTokens`, `stableStringify` |
| `@jevshield/core/security` | `injectSecurityGate`, `extractSecurityVerdict` |
| `@jevshield/core/router` | `GeminiCascadeRouter` / `CascadeRouter` |
| `@jevshield/core/renderer` | normalization + prose rendering |

---

## Environment variables

| Variable | Required | Used for |
|---|---|---|
| `TYPESAFE_API_KEY` | **yes** (unless passed explicitly) | `Authorization: Bearer` to TypeSafe |
| `TYPESAFE_BASE_URL` | no | Alternate Jev endpoint / gateway |
| `JEVD_MODEL` | no | Default model alias (`jev-latest`) |
| `JEVD_CONFIDENCE_THRESHOLD` | no | Default escalation threshold (`0.6`) |
| `JEVD_FALLBACK_ENDPOINT` | no | Endpoint when `provider: "custom"` and no `endpoint` given |
| `GEMINI_API_KEY` | for the Gemini provider | Fallback escalation |
| `GEMINI_MODEL` | no | Defaults to `gemini-2.5-flash` |
| `ANTHROPIC_API_KEY` | for the Anthropic provider | Fallback escalation |
| `ANTHROPIC_MODEL` | no | Defaults to `claude-sonnet-4-5` |

Copy [`.env.example`](.env.example) to `.env`. `.env` is gitignored.

> **Browser bundlers:** `process.env` is read only as a *fallback* when no explicit key is passed,
> and `??` / `||` short-circuit, so passing keys explicitly means `process` is never dereferenced.
> In a browser or webview, still shim `globalThis.process ??= { env: {} }` before importing. This
> is exactly what JevShield Studio does.

---

## Design decisions and gotchas

**Discriminants are lowercase.** The wire protocol is `"noul" | "choice" | "score"` and the option
map is `criteria`. PascalCase on the wire is rejected with a `422`, so the injected guardrail
question is `{ "type": "noul", ... }`.

**One round trip, not two.** Jev evaluates every question against the same state in parallel, so
the adversarial check costs one extra answer rather than a second HTTP call.

**Determinism is a feature.** `enrichState` accepts an optional `now`; identical input and
reference instant produce byte-identical output. Prose rendering is templated, never
model-generated, so the same decisions always render the same text.

**Escalation is lazy and non-fatal.** Providers are resolved on first need, so a missing
`GEMINI_API_KEY` never breaks construction, and a failed fallback degrades to the deterministic
rendering with a logged warning.

**One place talks to Gemini.** `@google/genai` is a direct dependency and every Gemini call goes
through `GeminiCascadeRouter`; `GeminiFallback` delegates to it rather than duplicating request
construction. `@anthropic-ai/sdk` stays optional and loads lazily.

**Confidence is the minimum, not the average.** One weak signal is enough to warrant escalation,
so averaging would hide it.

**Truncation reports itself.** Nothing is silently dropped: `__jevshield.truncation` names the
strategy and both token counts.

**`enrichedState` presence is conditional.** It appears only for object state with enrichment
enabled — do not assume it exists.

#### Enrichment scope

`enrichState` takes a `Record<string, unknown>`, because a string or array root has nowhere to put
the derived block without changing what Jev sees. The facade therefore:

- enriches object state,
- passes string and array state through untouched (the `enricher` stage reports `bypassed`),
- throws `JevValidationError` if a string/array state exceeds the input budget, since only object
  state can be auto-truncated.

---

## Development

```bash
npm install         # install both workspaces

npm run typecheck   # tsc -p tsconfig.json --noEmit  (strict)
npm test            # vitest run
npm run build       # tsc -p tsconfig.build.json → dist/ + .d.ts
```

Workspace scripts — run from the repository root:

```bash
npm run studio:dev           # Vite dev server on :1420
npm run studio:typecheck
npm run studio:test          # studio engine tests
npm run studio:build         # typecheck + production bundle
npm run studio:tauri:dev     # desktop shell (needs a Rust toolchain)
npm run studio:tauri:build
```

To pass arbitrary flags to the Tauri CLI, use the workspace form directly — a root
`npm run <script> -- <flag>` appends the flag to the *inner* npm invocation and it gets swallowed:

```bash
npm run tauri -w @jevshield/studio -- dev --help
```

### Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and on every pull request. It has one job
per workspace — `core` and `studio` — and each job runs the full typecheck / test / build sequence
on **Node 22 and Node 24** (`npm ci`, so the lockfile is authoritative).

CI does **not** build the Tauri desktop shell: the Rust crate has never been compiled and needs a
system Rust toolchain plus platform WebView dependencies that a default runner does not provide.

### Module map

```
src/
├── index.ts                       JevShield facade + all public exports
├── types/index.ts                 wire types, limits, options, result shapes
├── errors.ts                      typed error hierarchy
├── client/jevClient.ts            axios + p-retry transport
├── client/schemas.ts              zod validation + hard-limit enforcement
├── enricher/stateEnricher.ts      deterministic derivation + truncation
├── security/dualGuardrail.ts      adversarial question + verdict extraction
├── router/cascadeRouter.ts        Gemini Flash text generation (@google/genai)
├── fallback/generativeFallback.ts Gemini / Anthropic / custom endpoint
└── renderer/decisionRenderer.ts   normalization + deterministic prose
```

### Test coverage

`npm test` runs 61 tests across the six core modules: enrichment determinism and truncation
(including cycle safety), guardrail injection and verdict bands, response schema parsing and
limit enforcement, decision normalization and prose rendering, router request construction with a
mocked `@google/genai`, and facade-level cascade integration over a stubbed transport.

`apps/studio` adds 19 engine tests covering the demo pipeline, the tree chunker, the injection
heuristic and confidence routing.

### Verified

- `tsc --noEmit` clean under `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`
- 61 core tests + 19 studio tests passing
- `npm run build` emits `dist/` and `.d.ts`; the built ESM entry imports cleanly
- Studio `vite build` succeeds with Monaco / recharts / dockview / `@google/genai` split into
  separate chunks

---

## Known limitations

- **`p-retry` and `zod` APIs move.** Pinned to `p-retry@8` and `zod@4`. The zod usage is written to
  work on both v3 and v4, but the lockfile resolves v4.
- **Token counting is a heuristic** (`chars / 4`), not a tokenizer. Budget with margin.
- **Enrichment is object-only** for the reasons above.
- **The Anthropic provider is loaded by dynamic import with a non-literal specifier**, so bundlers
  cannot statically detect `@anthropic-ai/sdk`. Install it explicitly if you use that provider.
- **`hard-truncate` cannot guarantee the budget for pathologically small limits** — if even a
  minimal envelope exceeds `maxInputTokens`, `finalTokens` will exceed it and the report says so.
- **The `custom` fallback provider assumes an OpenAI-compatible response shape.** It falls back to
  `text`, `output`, `completion` and `content` keys, but a radically different API needs a custom
  `GenerativeFallback`.
- **No retry inside the fallback providers.** `GeminiCascadeRouter` makes one attempt; wrap it
  yourself or rely on the facade's degradation path.
- **Cost figures in JevShield Studio are placeholder rates**, not published prices.

---

## License

Apache-2.0 — see [LICENSE](./LICENSE).
