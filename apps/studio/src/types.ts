import type {
  JevAnswers,
  JevDecision,
  JevQuestions,
} from "@jevshield/core";

export type StudioMode = "live" | "demo";

export type QuestionKind = "noul" | "choice" | "score";

/** The stages rendered by {@link CascadeGraph}, in execution order. */
export type CascadeStageId =
  | "input"
  | "enricher"
  | "security"
  | "chunker"
  | "confidence"
  | "action";

export type StageStatus =
  | "pending"
  | "passed"
  | "bypassed"
  | "warn"
  | "blocked"
  | "escalated";

export interface StageResult {
  id: CascadeStageId;
  label: string;
  status: StageStatus;
  /** One-line outcome, shown on the node itself. */
  summary: string;
  /** Bullet list shown in the node detail pane. */
  details: string[];
  durationMs: number;
}

/** The routing decision the pipeline settled on. */
export type CascadeAction =
  | "auto-act"
  | "human-escalation"
  | "generative-cascade"
  | "blocked";

export interface Thresholds {
  /** At or above this confidence the pipeline acts without review. */
  autoAct: number;
  /** Below this confidence the pipeline escalates to Gemini. */
  cascade: number;
}

export interface RunSnapshot {
  stateText: string;
  questions: JevQuestions;
  guardrailsEnabled: boolean;
  thresholds: Thresholds;
  model: string;
}

export interface RunLatency {
  totalMs: number;
  enricherMs: number;
  jevLatencyMs: number;
  geminiLatencyMs: number;
}

export interface RunUsage {
  jevInputTokens: number;
  jevOutputTokens: number;
  geminiInputTokens: number;
  geminiOutputTokens: number;
  estimatedCostUsd: number;
}

export interface RunSecurity {
  present: boolean;
  blocked: boolean;
  injectionProbability: number;
  threshold: number;
}

export interface RunRecord {
  id: string;
  startedAt: string;
  mode: StudioMode;
  status: "ok" | "blocked" | "error";
  action: CascadeAction;
  error?: string;
  stages: StageResult[];
  answers: JevAnswers;
  decisions: JevDecision[];
  /** Lowest confidence across decisions; drives the cascade. */
  confidence: number;
  security: RunSecurity;
  prose: string;
  proseSource: "template" | "gemini";
  usage: RunUsage;
  latency: RunLatency;
  snapshot: RunSnapshot;
}

export interface Credentials {
  typesafeApiKey: string;
  geminiApiKey: string;
}

/** Aggregated enricher output for the live pre-processor preview. */
export interface EnrichmentPreview {
  ok: boolean;
  error: string | null;
  isObjectState: boolean;
  estimatedTokens: number;
  applied: boolean;
  strategy: string;
  dates: Array<{
    path: string;
    iso: string;
    elapsedDays: number;
    direction: string;
  }>;
  counts: Array<{ path: string; count: number }>;
  stats: Array<{
    path: string;
    count: number;
    sum: number;
    min: number;
    max: number;
    mean: number;
    median: number;
  }>;
  dateDifferences: Array<{ pair: string; days: number }>;
}

export interface RunPipelineInput {
  stateText: string;
  questions: JevQuestions;
  guardrailsEnabled: boolean;
  thresholds: Thresholds;
  model: string;
  credentials: Credentials;
  mode: StudioMode;
  /** Monotonic counter used to vary simulated runs. */
  runIndex: number;
}
