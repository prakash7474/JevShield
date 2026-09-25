import type { AxiosInstance } from "axios";

/**
 * @jevshield/core — shared type surface.
 *
 * Everything in this file mirrors the wire contract of `POST /v1/systemone`
 * as documented at https://docs.typesafe.ai/api. The discriminants are
 * deliberately lowercase (`"noul" | "choice" | "score"`) because that is what
 * the API accepts and emits; using PascalCase on the wire yields a 422.
 */

/* -------------------------------------------------------------------------- *
 * Instructions
 * -------------------------------------------------------------------------- */

/**
 * A question's `instructions` may be a plain string, an object holding the
 * question plus the data it references (referenced by name in backticks), or
 * an array combining both.
 */
export type JevInstructions =
  | string
  | { [key: string]: JevInstructions }
  | JevInstructions[];

/* -------------------------------------------------------------------------- *
 * Questions
 * -------------------------------------------------------------------------- */

export type JevQuestionType = "noul" | "choice" | "score";

/** Optional descriptions of what a `true` (near 1) and `false` (near 0) mean. */
export interface JevNoulCriteria {
  true?: JevInstructions;
  false?: JevInstructions;
}

/** Yes/no question. The answer is the probability that the answer is "yes". */
export interface JevNoulQuestion {
  type: "noul";
  instructions: JevInstructions;
  criteria?: JevNoulCriteria;
}

/**
 * Pick-one question. `criteria` maps an option label to its rubric
 * description; use `null` when an option needs no extra detail.
 * Maximum of {@link JEV_LIMITS.maxChoiceOptions} options.
 */
export interface JevChoiceQuestion {
  type: "choice";
  instructions: JevInstructions;
  criteria: Record<string, JevInstructions | null>;
}

/**
 * Rubric rating question. `criteria` is an ordered array of level
 * descriptions; between {@link JEV_LIMITS.minScoreLevels} and
 * {@link JEV_LIMITS.maxScoreLevels} levels.
 */
export interface JevScoreQuestion {
  type: "score";
  instructions: JevInstructions;
  criteria: JevInstructions[];
}

export type JevQuestion =
  | JevNoulQuestion
  | JevChoiceQuestion
  | JevScoreQuestion;

/** A map of author-chosen question ids to typed questions. */
export type JevQuestions = Record<string, JevQuestion>;

/** A map of the same ids to their answers. */
export type JevAnswers = Record<string, JevAnswer>;

/* -------------------------------------------------------------------------- *
 * Request
 * -------------------------------------------------------------------------- */

/** The content Jev evaluates: raw text, or structured application state. */
export type JevState = string | Record<string, unknown> | unknown[];

export interface JevRequestPayload {
  state: JevState;
  /** Model id or alias, e.g. `"jev-latest"`. */
  model: string;
  questions: JevQuestions;
}

/* -------------------------------------------------------------------------- *
 * Answers / response
 * -------------------------------------------------------------------------- */

export interface JevNoulAnswer {
  type: "noul";
  /** Yes/no probability on a scale from 0 (no) to 1 (yes). */
  noul: number;
}

export interface JevChoiceAnswer {
  type: "choice";
  /** The highest-probability option. */
  choice: string;
  /** Every option mapped to its probability; values sum to 1. */
  probabilities: Record<string, number>;
  /** Model certainty, derived from the probability distribution. */
  confidence: number;
}

export interface JevScoreAnswer {
  type: "score";
  /** Probability-weighted value across the levels; may land between levels. */
  score: number;
  /** Level index (as a string key) mapped back to its description. */
  legend: Record<string, string>;
  /** Each level mapped to its probability; values sum to 1. */
  probabilities: Record<string, number>;
  /** Model certainty, derived from the probability distribution. */
  confidence: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface JevResponse {
  /** The concrete model that performed the evaluation, e.g. `"jev-1.13.0"`. */
  model: string;
  answers: JevAnswers;
  usage: JevUsage;
}

/** HTTP error body shape returned by the evaluation endpoint. */
export interface JevErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: string;
    param?: string;
  };
  message?: string;
  detail?: unknown;
}

/* -------------------------------------------------------------------------- *
 * Hard limits (weakness #2)
 * -------------------------------------------------------------------------- */

export const JEV_LIMITS = {
  /** Maximum options allowed in a single `choice` question. */
  maxChoiceOptions: 255,
  /** Score questions must define at least this many levels. */
  minScoreLevels: 2,
  /** Score questions may define at most this many levels. */
  maxScoreLevels: 10,
  /** Documented input ceiling for a single evaluation. */
  maxInputTokens: 32_000,
  /** Documented output ceiling for a single evaluation. */
  maxOutputTokens: 64_000,
} as const;

/* -------------------------------------------------------------------------- *
 * Client configuration
 * -------------------------------------------------------------------------- */

export interface JevRetryConfig {
  /** Number of retries after the initial attempt. */
  retries: number;
  /** Lower bound (ms) for the exponential backoff. */
  minTimeoutMs: number;
  /** Upper bound (ms) for the exponential backoff. */
  maxTimeoutMs: number;
  /** Backoff multiplier. */
  factor: number;
  /** Whether 429/529/5xx responses are retried. */
  retryOnServerErrors: boolean;
}

export const DEFAULT_RETRY_CONFIG: JevRetryConfig = {
  retries: 3,
  minTimeoutMs: 500,
  maxTimeoutMs: 8_000,
  factor: 2,
  retryOnServerErrors: true,
};

/* -------------------------------------------------------------------------- *
 * Enricher (weakness #1)
 * -------------------------------------------------------------------------- */

export interface DateDerivation {
  /** ISO-8601 representation of the parsed instant. */
  iso: string;
  /** Signed days from this instant to "now" (positive = in the past). */
  elapsed_days: number;
  elapsed_hours: number;
  elapsed_seconds: number;
  direction: "past" | "future" | "now";
}

export interface NumericStats {
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  median: number;
}

export type TruncationStrategy =
  | "none"
  | "string-cap"
  | "array-cap"
  | "hard-truncate";

export interface TruncationReport {
  applied: boolean;
  strategy: TruncationStrategy;
  estimatedTokens: number;
  finalTokens: number;
  maxTokens: number;
  /** Present only for the `hard-truncate` strategy. */
  preview?: string;
}

/** Deterministic, derived context injected under `__jevshield`. */
export interface EnrichmentDerived {
  schema_version: string;
  generated_at: string;
  generated_at_epoch_ms: number;
  /** Derived facts about every date-like field found in the state. */
  dates: Record<string, DateDerivation>;
  /** `path -> length` for every array in the state. */
  counts: Record<string, number>;
  /** Aggregate statistics for every array of numbers. */
  stats: Record<string, NumericStats>;
  /** Signed day deltas between date fields, keyed `"<from>-><to>"`. */
  date_differences: Record<string, number>;
  /** Output of caller-supplied calculators, namespaced by their key. */
  custom: Record<string, unknown>;
  truncation: TruncationReport;
}

/**
 * The enriched state. The original payload is preserved verbatim and the
 * derived block is added under {@link ENRICHMENT_KEY}.
 */
export interface EnrichedState {
  [key: string]: unknown;
}

export type CustomCalculator = (
  state: Record<string, unknown>,
  context: CustomCalculatorContext,
) => Record<string, unknown> | void;

export interface CustomCalculatorContext {
  now: Date;
  derived: EnrichmentDerived;
}

export type CustomCalculatorInput =
  | CustomCalculator
  | CustomCalculator[]
  | Record<string, CustomCalculator>;

export interface EnrichStateOptions {
  /**
   * Fixed reference instant. Supply this to make enrichment fully
   * reproducible in tests and replays; defaults to `new Date()`.
   */
  now?: Date | number | string;
  /** Token budget the enriched payload must fit inside. */
  maxInputTokens?: number;
  /** Compute pairwise day deltas between date fields. Default `true`. */
  computeDateDifferences?: boolean;
  /** Compute min/max/mean/median for numeric arrays. Default `true`. */
  computeStats?: boolean;
  /** Abort with a hard error instead of truncating when over budget. */
  strictTokenBudget?: boolean;
}

/* -------------------------------------------------------------------------- *
 * Security (weaknesses #3)
 * -------------------------------------------------------------------------- */

export interface SecurityGateOptions {
  /** Override the reserved question id. */
  key?: string;
  /** Override the adversarial detection instructions. */
  instructions?: JevInstructions;
  /** Override the yes/no criteria descriptions. */
  criteria?: JevNoulCriteria;
  /** Probability at or above which the state is considered adversarial. */
  threshold?: number;
  /** Behaviour when the reserved id is already present in `questions`. */
  onConflict?: "throw" | "replace" | "skip";
}

export interface SecurityVerdict {
  /** Whether the adversarial question was found in the response. */
  present: boolean;
  key: string;
  /** Probability the state is attempting injection, in `[0, 1]`. */
  injectionProbability: number;
  threshold: number;
  blocked: boolean;
  severity: "none" | "low" | "medium" | "high";
}

/* -------------------------------------------------------------------------- *
 * Fallback / generative bindings (weaknesses #4 and #5)
 * -------------------------------------------------------------------------- */

export type FallbackProvider = "gemini" | "anthropic" | "custom";

export interface JevFallbackConfig {
  provider?: FallbackProvider;
  /** Defaults to `GEMINI_API_KEY` / `ANTHROPIC_API_KEY`. */
  apiKey?: string;
  /** Defaults per provider; see the provider factory. */
  model?: string;
  /**
   * Used when `provider` is `"custom"`. An OpenAI-compatible
   * `POST <endpoint>` accepting `{ messages, model }`.
   */
  endpoint?: string;
  systemInstruction?: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** Per-request timeout for the fallback call, in ms. */
  timeoutMs?: number;
}

export type FallbackReason =
  | "low-confidence"
  | "unsupported-question"
  | "adversarial-state";

export interface FallbackRequest {
  questionId: string;
  question: JevQuestion;
  state: JevState;
  reason: FallbackReason;
  /** Confidence reported by Jev, when the fallback is confidence-driven. */
  confidence?: number;
}

export interface FallbackUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export interface FallbackResult {
  text: string;
  provider: FallbackProvider | string;
  model: string;
  usage?: FallbackUsage;
}

export interface GenerativeFallback {
  readonly provider: FallbackProvider | string;
  generate(request: FallbackRequest): Promise<FallbackResult>;
}

/* -------------------------------------------------------------------------- *
 * Facade configuration
 * -------------------------------------------------------------------------- */

export interface JevShieldLogger {
  debug?: (message: string, meta?: unknown) => void;
  info?: (message: string, meta?: unknown) => void;
  warn?: (message: string, meta?: unknown) => void;
  error?: (message: string, meta?: unknown) => void;
}

/**
 * Options for the {@link JevShield} facade. `apiKey` falls back to
 * `process.env.TYPESAFE_API_KEY`.
 */
export interface JevShieldOptions {
  /** Defaults to `process.env.TYPESAFE_API_KEY`. */
  apiKey?: string;
  /** Defaults to `process.env.TYPESAFE_BASE_URL` or `https://api.typesafe.ai`. */
  baseUrl?: string;
  /** Defaults to `process.env.JEVD_MODEL` or `"jev-latest"`. */
  model?: string;
  /** Per-request HTTP timeout in ms. Default `60_000`. */
  timeoutMs?: number;
  retryConfig?: Partial<JevRetryConfig>;
  /** Agreement below which a decision is escalated. Default `0.6`. */
  confidenceThreshold?: number;
  /** Prose endpoint used by the `"custom"` fallback provider. */
  fallbackEndpoint?: string;
  /** `false` disables generative escalation entirely. */
  fallback?: JevFallbackConfig | false;
  /** `false` disables deterministic state enrichment. */
  enricher?: EnrichStateOptions | false;
  /** `false` disables the injected adversarial question. */
  guardrails?: SecurityGateOptions | false;
  /** Behaviour when the adversarial check fires. Default `"throw"`. */
  onInjection?: "throw" | "flag" | "fallback";
  /** Prefer fallback prose over rendered decision prose. Default `true`. */
  preferFallbackProse?: boolean;
  /** Escape hatch for tests and custom transports. */
  httpClient?: AxiosInstance;
  logger?: JevShieldLogger;
}

export interface DecideOptions {
  state: JevState;
  questions: JevQuestions;
  model?: string;
  enrich?: boolean;
  guardrails?: boolean;
  renderProse?: boolean;
  confidenceThreshold?: number;
  fallback?: boolean;
}

/** A normalized, renderable view over a single Jev answer. */
export interface JevDecision {
  id: string;
  type: JevQuestionType;
  /** `noul` probability, `choice` label or `score` value. */
  value: number | string;
  /** Probability assigned to the winning outcome, when there is one. */
  probability?: number;
  /** Human label for the winning outcome (choice option or score level). */
  label?: string;
  /** Normalized certainty in `[0, 1]`. */
  confidence: number;
  probabilities: Record<string, number>;
  answer: JevAnswer;
  question?: JevQuestion;
}

export interface JevShieldResult {
  model: string;
  usage: JevUsage;
  answers: JevAnswers;
  decisions: JevDecision[];
  /** Lowest confidence across all returned decisions. */
  confidence: number;
  lowConfidence: boolean;
  prose: string;
  security: SecurityVerdict;
  enrichedState?: EnrichedState;
  fallback?: FallbackResult;
  raw: JevResponse;
}
