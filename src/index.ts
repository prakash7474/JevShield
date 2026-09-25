import { JevClient } from "./client/jevClient.js";
import { DEFAULT_MAX_INPUT_TOKENS, enrichState, estimateTokens } from "./enricher/stateEnricher.js";
import { JevShieldSecurityError, JevValidationError } from "./errors.js";
import { createFallback } from "./fallback/generativeFallback.js";
import {
  lowestConfidenceDecision,
  overallConfidence,
  renderProse,
  toDecisions,
} from "./renderer/decisionRenderer.js";
import {
  ADVERSARIAL_CHECK_KEY,
  extractSecurityVerdict,
  injectSecurityGate,
} from "./security/dualGuardrail.js";
import type {
  DecideOptions,
  EnrichedState,
  EnrichStateOptions,
  FallbackResult,
  GenerativeFallback,
  JevAnswers,
  JevDecision,
  JevFallbackConfig,
  JevShieldOptions,
  JevShieldResult,
  JevState,
  SecurityGateOptions,
  SecurityVerdict,
} from "./types/index.js";

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [candidate, value] of Object.entries(record)) {
    if (candidate !== key) out[candidate] = value;
  }
  return out;
}

function resolveConfidenceThreshold(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const fromEnv = Number(process.env["JEVD_CONFIDENCE_THRESHOLD"]);
  return Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv <= 1
    ? fromEnv
    : DEFAULT_CONFIDENCE_THRESHOLD;
}

/**
 * Enterprise wrapper around TypeSafe AI's Jev System One model.
 *
 * Every call runs the same deterministic pipeline:
 * 1. **Enrich** the state so Jev can reason about dates, counts and aggregates.
 * 2. **Guard** it with a parallel adversarial `noul` question in the same round trip.
 * 3. **Evaluate** via a retrying HTTP client.
 * 4. **Escalate** to a generative provider when confidence is too low or the
 *    state looks adversarial and `onInjection: "fallback"` is set.
 * 5. **Render** the typed decisions into deterministic prose.
 */
export class JevShield {
  readonly #client: JevClient;
  readonly #confidenceThreshold: number;
  readonly #enricher: EnrichStateOptions | null;
  readonly #guardrails: SecurityGateOptions | null;
  readonly #onInjection: "throw" | "flag" | "fallback";
  readonly #preferFallbackProse: boolean;
  readonly #fallbackConfig: JevFallbackConfig;
  readonly #fallbackDisabled: boolean;
  readonly #logger: JevShieldOptions["logger"];

  #fallback: GenerativeFallback | null | undefined = undefined;

  constructor(options: JevShieldOptions = {}) {
    this.#client = new JevClient({
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.retryConfig === undefined
        ? {}
        : { retryConfig: options.retryConfig }),
      ...(options.httpClient === undefined
        ? {}
        : { httpClient: options.httpClient }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });

    this.#logger = options.logger;
    this.#confidenceThreshold = resolveConfidenceThreshold(
      options.confidenceThreshold,
    );
    this.#enricher = options.enricher === false ? null : (options.enricher ?? {});
    this.#guardrails =
      options.guardrails === false ? null : (options.guardrails ?? {});
    this.#onInjection = options.onInjection ?? "throw";
    this.#preferFallbackProse = options.preferFallbackProse ?? true;
    this.#fallbackDisabled = options.fallback === false;
    this.#fallbackConfig = {
      ...(options.fallbackEndpoint === undefined
        ? {}
        : { endpoint: options.fallbackEndpoint }),
      ...(options.fallback === false ? {} : (options.fallback ?? {})),
    };
  }

  /**
   * Resolves the fallback lazily so a missing provider key surfaces only when
   * escalation is actually attempted, never during construction.
   */
  #getFallback(): GenerativeFallback | null {
    if (this.#fallbackDisabled) return null;
    if (this.#fallback !== undefined) return this.#fallback;
    try {
      this.#fallback = createFallback(this.#fallbackConfig);
    } catch (error) {
      this.#logger?.warn?.(
        "Generative fallback is unavailable; continuing with Jev decisions only.",
        error,
      );
      this.#fallback = null;
    }
    return this.#fallback;
  }

  #prepareState(state: JevState): {
    state: JevState;
    enrichedState?: EnrichedState;
  } {
    if (this.#enricher === null) return { state };

    if (typeof state === "string" || Array.isArray(state)) {
      const tokens = estimateTokens(state);
      if (tokens > DEFAULT_MAX_INPUT_TOKENS) {
        throw new JevValidationError(
          `State is ~${tokens} tokens, above the ${DEFAULT_MAX_INPUT_TOKENS} token budget, and only structured object state can be auto-truncated. Pass an object so JevShield can enrich and trim it.`,
        );
      }
      return { state };
    }

    const enrichedState = enrichState(
      state as Record<string, unknown>,
      undefined,
      this.#enricher,
    );
    return { state: enrichedState, enrichedState };
  }

  /** Runs the full JevShield pipeline for a single evaluation. */
  async decide(input: DecideOptions): Promise<JevShieldResult> {
    const useEnricher = input.enrich ?? this.#enricher !== null;
    const useGuardrails = input.guardrails ?? this.#guardrails !== null;
    const threshold = input.confidenceThreshold ?? this.#confidenceThreshold;

    const prepared = useEnricher
      ? this.#prepareState(input.state)
      : { state: input.state as JevState };

    let questions = input.questions;
    let securityKey = ADVERSARIAL_CHECK_KEY;
    if (useGuardrails) {
      const gate = injectSecurityGate(questions, this.#guardrails ?? {});
      questions = gate.questions;
      securityKey = gate.key;
    }

    const raw = await this.#client.evaluate({
      state: prepared.state,
      questions,
      model: input.model ?? this.#client.model,
    });

    const security: SecurityVerdict = useGuardrails
      ? extractSecurityVerdict(raw, {
          key: securityKey,
          ...(this.#guardrails?.threshold === undefined
            ? {}
            : { threshold: this.#guardrails.threshold }),
        })
      : extractSecurityVerdict(raw, { key: securityKey });

    const callerAnswers: JevAnswers = omitKey(raw.answers, securityKey);
    const decisions: JevDecision[] = toDecisions(callerAnswers, input.questions);
    const confidence = overallConfidence(decisions);
    const lowConfidence = confidence < threshold;

    let fallback: FallbackResult | undefined;

    if (security.blocked) {
      if (this.#onInjection === "throw") {
        throw new JevShieldSecurityError(security);
      }
      if (this.#onInjection === "fallback") {
        fallback = await this.#escalate(
          input,
          prepared.state,
          decisions,
          securityKey,
          "adversarial-state",
          security.injectionProbability,
        );
      }
    }

    // Escalation opt-in is the fallback configuration itself, not the
    // injection policy: a configured provider must fire whenever Jev is unsure.
    if (fallback === undefined && lowConfidence && (input.fallback ?? true)) {
      fallback = await this.#escalate(
        input,
        prepared.state,
        decisions,
        undefined,
        "low-confidence",
        confidence,
      );
    }

    const renderProseEnabled = input.renderProse ?? true;
    const rendered = renderProseEnabled ? renderProse(decisions) : "";
    const prose =
      fallback && this.#preferFallbackProse ? fallback.text : rendered;

    return {
      model: raw.model,
      usage: raw.usage,
      answers: raw.answers,
      decisions,
      confidence,
      lowConfidence,
      prose,
      security,
      ...(prepared.enrichedState === undefined
        ? {}
        : { enrichedState: prepared.enrichedState }),
      ...(fallback === undefined ? {} : { fallback }),
      raw,
    };
  }

  async #escalate(
    input: DecideOptions,
    state: JevState,
    decisions: JevDecision[],
    excludeId: string | undefined,
    reason: "low-confidence" | "adversarial-state",
    confidence: number,
  ): Promise<FallbackResult | undefined> {
    const fallback = this.#getFallback();
    if (!fallback) return undefined;

    const target =
      excludeId === undefined
        ? lowestConfidenceDecision(decisions)
        : undefined;

    const questionIds = Object.keys(input.questions).filter(
      (id) => id !== excludeId,
    );
    const questionId =
      target?.id ?? questionIds[0] ?? Object.keys(input.questions)[0];
    if (!questionId) return undefined;

    const question = input.questions[questionId];
    if (!question) return undefined;

    try {
      return await fallback.generate({
        questionId,
        question,
        state,
        reason,
        confidence,
      });
    } catch (error) {
      this.#logger?.warn?.("Generative fallback failed.", error);
      return undefined;
    }
  }
}

/** Convenience factory mirroring {@link JevShield}. */
export function createShield(options: JevShieldOptions = {}): JevShield {
  return new JevShield(options);
}

/* -------------------------------------------------------------------------- *
 * Public surface
 * -------------------------------------------------------------------------- */

export { JevClient, createJevClient } from "./client/jevClient.js";
export type { JevClientOptions } from "./client/jevClient.js";

export {
  DEFAULT_MAX_INPUT_TOKENS,
  ENRICHMENT_KEY,
  ENRICHMENT_SCHEMA_VERSION,
  enrichState,
  estimateTokens,
  stableStringify,
} from "./enricher/stateEnricher.js";

export {
  ADVERSARIAL_CHECK_CRITERIA,
  ADVERSARIAL_CHECK_INSTRUCTIONS,
  ADVERSARIAL_CHECK_KEY,
  DEFAULT_INJECTION_THRESHOLD,
  extractSecurityVerdict,
  injectSecurityGate,
} from "./security/dualGuardrail.js";
export type { SecurityGateResult } from "./security/dualGuardrail.js";

export {
  lowestConfidenceDecision,
  normalizeAnswer,
  overallConfidence,
  renderDecision,
  renderDecisionReport,
  renderDecisionSentence,
  renderProse,
  toDecisions,
} from "./renderer/decisionRenderer.js";

export {
  buildFallbackPrompt,
  createFallback,
  DEFAULT_FALLBACK_MODELS,
} from "./fallback/generativeFallback.js";

export {
  CascadeRouter,
  DEFAULT_CASCADE_MODEL,
  GeminiCascadeRouter,
} from "./router/cascadeRouter.js";
export type {
  CascadeGeneration,
  CascadeRouterOptions,
} from "./router/cascadeRouter.js";

export {
  answerConfidence,
  parseJevResponse,
  validateQuestions,
} from "./client/schemas.js";

export {
  JevAuthError,
  JevFallbackError,
  JevOverloadedError,
  JevRateLimitError,
  JevResponseError,
  JevShieldConfigError,
  JevShieldError,
  JevShieldSecurityError,
  JevTransportError,
  JevValidationError,
} from "./errors.js";

export * from "./types/index.js";
