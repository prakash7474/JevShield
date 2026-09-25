import {
  ADVERSARIAL_CHECK_KEY,
  DEFAULT_MAX_INPUT_TOKENS,
  ENRICHMENT_KEY,
  GeminiCascadeRouter,
  JevClient,
  enrichState,
  estimateTokens,
  extractSecurityVerdict,
  injectSecurityGate,
  lowestConfidenceDecision,
  overallConfidence,
  renderDecisionReport,
  renderProse,
  toDecisions,
  type EnrichmentDerived,
  type JevAnswers,
  type JevChoiceAnswer,
  type JevQuestions,
  type JevResponse,
  type JevState,
} from "@jevshield/core";

import type {
  CascadeAction,
  RunLatency,
  RunPipelineInput,
  RunRecord,
  RunSecurity,
  StageResult,
  StageStatus,
} from "../types";
import { mergeChunkedChoice, planChunks, type ChunkPlan } from "./chunker";
import { hashString, simulateGeminiProse, simulateJevResponse } from "./demoData";
import { emptyUsage, estimateCost } from "./pricing";

/** A state payload the pipeline cannot accept. Surfaced without appending a run. */
export class RunInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunInputError";
  }
}

/** Adversarial scores at or above this block the run. Matches JevShield core. */
export const GUARDRAIL_THRESHOLD = 0.5;

export const GEMINI_MODEL = "gemini-2.5-flash";

const GEMINI_SYSTEM_INSTRUCTION =
  "You are the generative escalation layer of a Jev decision pipeline. Jev has already resolved the typed, probabilistic decisions. Write a concise operational summary for a human reviewer: what was decided, how confident each signal was, and the recommended next action. Ground every sentence in the supplied decisions and state, and never invent facts that are not present.";

interface ParsedState {
  value: JevState;
  isObject: boolean;
}

/** Parses the editor contents into something the pipeline can evaluate. */
export function parseStateText(stateText: string): ParsedState {
  const trimmed = stateText.trim();
  if (!trimmed) {
    throw new RunInputError("State is empty. Paste a payload or load a sample.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new RunInputError(
      `State is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (Array.isArray(parsed)) return { value: parsed, isObject: false };
  if (parsed !== null && typeof parsed === "object") {
    return { value: parsed as Record<string, unknown>, isObject: true };
  }
  return { value: String(parsed), isObject: false };
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [candidate, value] of Object.entries(record)) {
    if (candidate !== key) out[candidate] = value;
  }
  return out;
}

/** Which band a confidence value falls into, given the configured thresholds. */
export function confidenceBand(
  confidence: number,
  thresholds: { autoAct: number; cascade: number },
): CascadeAction {
  if (confidence >= thresholds.autoAct) return "auto-act";
  if (confidence < thresholds.cascade) return "generative-cascade";
  return "human-escalation";
}

/* -------------------------------------------------------------------------- *
 * Chunk-aware evaluation (live mode)
 * -------------------------------------------------------------------------- */

async function evaluateWithChunking(
  client: JevClient,
  state: JevState,
  questions: JevQuestions,
  plan: ChunkPlan,
  model: string,
): Promise<JevResponse> {
  const chunkedIds = new Set(plan.groups.map((group) => group.questionId));

  const baseQuestions: JevQuestions = {};
  for (const [id, question] of Object.entries(questions)) {
    if (!chunkedIds.has(id)) baseQuestions[id] = question;
  }

  const answers: JevAnswers = {};
  let inputTokens = 0;
  let outputTokens = 0;
  let responseModel = model;

  if (Object.keys(baseQuestions).length > 0) {
    const response = await client.evaluate({
      state,
      model,
      questions: baseQuestions,
    });
    Object.assign(answers, response.answers);
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    responseModel = response.model;
  }

  for (const group of plan.groups) {
    const chunkAnswers: Array<{ options: string[]; answer: JevChoiceAnswer }> = [];

    for (const chunk of group.chunks) {
      const response = await client.evaluate({
        state,
        model,
        questions: { [group.questionId]: chunk.question },
      });
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      responseModel = response.model;

      const answer = response.answers[group.questionId];
      if (answer && answer.type === "choice") {
        chunkAnswers.push({ options: chunk.options, answer });
      }
    }

    if (chunkAnswers.length > 0) {
      answers[group.questionId] = mergeChunkedChoice(chunkAnswers);
    }
  }

  return {
    model: responseModel,
    answers,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

/* -------------------------------------------------------------------------- *
 * Pipeline
 * -------------------------------------------------------------------------- */

export async function runPipeline(input: RunPipelineInput): Promise<RunRecord> {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date().toISOString();
  const runStarted = performance.now();

  const snapshot = {
    stateText: input.stateText,
    questions: input.questions,
    guardrailsEnabled: input.guardrailsEnabled,
    thresholds: input.thresholds,
    model: input.model,
  };

  const stages: StageResult[] = [];

  /* --- 1. Raw state input ------------------------------------------------ */
  const parsed = parseStateText(input.stateText);
  stages.push({
    id: "input",
    label: "Raw State Input",
    status: "passed",
    summary: parsed.isObject
      ? `Object state · ${Object.keys(parsed.value as Record<string, unknown>).length} top-level keys`
      : `${Array.isArray(parsed.value) ? "Array" : "String"} state · enrichment unavailable`,
    details: [
      `${input.stateText.length.toLocaleString()} characters`,
      `~${estimateTokens(input.stateText).toLocaleString()} estimated tokens`,
    ],
    durationMs: 0,
  });

  /* --- 2. State enricher ------------------------------------------------- */
  const enrichStarted = performance.now();
  let workingState: JevState = parsed.value;
  let enrichment: EnrichmentDerived | null = null;
  let enrichStatus: StageStatus = "bypassed";
  let enrichSummary = "Skipped — only structured object state can be enriched.";
  const enrichDetails: string[] = [];

  if (parsed.isObject) {
    const enriched = enrichState(
      parsed.value as Record<string, unknown>,
      undefined,
      { now: new Date(), maxInputTokens: DEFAULT_MAX_INPUT_TOKENS },
    );
    workingState = enriched;

    const derived = enriched[ENRICHMENT_KEY];
    if (derived && typeof derived === "object") {
      enrichment = derived as EnrichmentDerived;
      const dateCount = Object.keys(enrichment.dates).length;
      const countCount = Object.keys(enrichment.counts).length;
      const statCount = Object.keys(enrichment.stats).length;
      const deltaCount = Object.keys(enrichment.date_differences).length;

      if (dateCount > 0) enrichDetails.push(`${dateCount} date field(s) derived`);
      if (countCount > 0) enrichDetails.push(`${countCount} array length(s) computed`);
      if (statCount > 0) enrichDetails.push(`${statCount} numeric aggregate(s) computed`);
      if (deltaCount > 0) {
        enrichDetails.push(`${deltaCount} day delta(s) between date fields`);
      }

      if (enrichment.truncation.applied) {
        enrichStatus = "warn";
        enrichSummary = `Truncated via "${enrichment.truncation.strategy}" to fit the token budget.`;
        enrichDetails.push(
          `~${enrichment.truncation.estimatedTokens.toLocaleString()} → ${enrichment.truncation.finalTokens.toLocaleString()} tokens (budget ${enrichment.truncation.maxTokens.toLocaleString()})`,
        );
      } else {
        enrichStatus = "passed";
        enrichSummary = `Derived ${dateCount} date(s), ${countCount} count(s), ${statCount} aggregate(s).`;
        enrichDetails.push(
          `Within the ${enrichment.truncation.maxTokens.toLocaleString()}-token budget`,
        );
      }
    }
  }

  const enricherMs = performance.now() - enrichStarted;
  stages.push({
    id: "enricher",
    label: "State Enricher",
    status: enrichStatus,
    summary: enrichSummary,
    details: enrichDetails,
    durationMs: enricherMs,
  });

  /* --- 3. Dual security gate -------------------------------------------- */
  const gate = input.guardrailsEnabled
    ? injectSecurityGate(input.questions, { threshold: GUARDRAIL_THRESHOLD })
    : null;
  const effectiveQuestions: JevQuestions = gate?.questions ?? input.questions;

  const securityStage: StageResult = {
    id: "security",
    label: "Dual Security Gate",
    status: input.guardrailsEnabled ? "pending" : "bypassed",
    summary: input.guardrailsEnabled
      ? "Awaiting adversarial verdict…"
      : "Disabled — no parallel adversarial question injected.",
    details: input.guardrailsEnabled
      ? [`Injected parallel "noul" question at ${ADVERSARIAL_CHECK_KEY}`]
      : ["Toggle the security firewall to enable injection checks."],
    durationMs: 0,
  };
  stages.push(securityStage);

  /* --- 4. Tree chunker --------------------------------------------------- */
  const plan = planChunks(effectiveQuestions);
  const chunkerDetails = plan.required
    ? plan.groups.map(
        (group) =>
          `${group.questionId}: ${group.totalOptions} options → ${group.chunks.length} chunks of ≤${plan.maxOptionsPerChunk}`,
      )
    : [`All Choice questions are within Jev's ${plan.maxOptionsPerChunk}-option ceiling.`];

  stages.push({
    id: "chunker",
    label: "Tree Chunker",
    status: plan.required ? "warn" : "bypassed",
    summary: plan.required
      ? `${plan.totalChunks} chunk request(s) planned.`
      : "Nothing to chunk.",
    details: chunkerDetails,
    durationMs: 0,
  });

  /* --- 5-9. Evaluate, gate, route, escalate ------------------------------ */
  const latency: RunLatency = {
    totalMs: 0,
    enricherMs,
    jevLatencyMs: 0,
    geminiLatencyMs: 0,
  };
  const usage = emptyUsage();

  /**
   * Records a mid-pipeline failure without disturbing the six graph nodes: the
   * confidence node carries the error and the action node shows it was never
   * reached.
   */
  const fail = (error: unknown): RunRecord => {
    const message = error instanceof Error ? error.message : String(error);
    stages.push({
      id: "confidence",
      label: "Confidence Threshold",
      status: "blocked",
      summary: "Not reached — evaluation failed.",
      details: [message],
      durationMs: 0,
    });
    stages.push({
      id: "action",
      label: "Cascade Action",
      status: "blocked",
      summary: "Not reached",
      details: ["No cascade action was taken because the evaluation failed."],
      durationMs: 0,
    });
    latency.totalMs = performance.now() - runStarted;
    usage.estimatedCostUsd = estimateCost(usage);
    return {
      id: runId,
      startedAt,
      mode: input.mode,
      status: "error",
      action: "blocked",
      error: message,
      stages,
      answers: {},
      decisions: [],
      confidence: 0,
      security: {
        present: false,
        blocked: false,
        injectionProbability: 0,
        threshold: GUARDRAIL_THRESHOLD,
      },
      prose: "",
      proseSource: "template",
      usage,
      latency,
      snapshot,
    };
  };

  let response: JevResponse;
  let seed = 0;

  try {
    if (input.mode === "demo") {
      seed = (hashString(input.stateText) ^ (input.runIndex * 2654435761)) >>> 0;
      // Emulate Jev's ~100 ms System One latency with deterministic jitter.
      latency.jevLatencyMs = 88 + (((seed % 61) + input.runIndex * 7) % 61);
      response = simulateJevResponse(effectiveQuestions, input.stateText, seed);
    } else {
      if (!input.credentials.typesafeApiKey) {
        throw new RunInputError(
          "Live mode needs a TYPESAFE_API_KEY. Add one in Settings or switch to demo mode.",
        );
      }
      const client = new JevClient({
        apiKey: input.credentials.typesafeApiKey,
        model: input.model,
      });
      const jevStarted = performance.now();
      response = await evaluateWithChunking(
        client,
        workingState,
        effectiveQuestions,
        plan,
        input.model,
      );
      latency.jevLatencyMs = performance.now() - jevStarted;
    }
  } catch (error) {
    return fail(error);
  }

  /* --- Security verdict ------------------------------------------------- */
  const verdict = input.guardrailsEnabled
    ? extractSecurityVerdict(response, {
        key: ADVERSARIAL_CHECK_KEY,
        threshold: GUARDRAIL_THRESHOLD,
      })
    : null;

  const security: RunSecurity = {
    present: verdict?.present ?? false,
    blocked: verdict?.blocked ?? false,
    injectionProbability: verdict?.injectionProbability ?? 0,
    threshold: GUARDRAIL_THRESHOLD,
  };

  if (verdict) {
    securityStage.status = verdict.blocked
      ? "blocked"
      : verdict.severity === "medium" || verdict.severity === "low"
        ? "warn"
        : "passed";
    securityStage.summary = verdict.blocked
      ? `Blocked — injection probability ${(verdict.injectionProbability * 100).toFixed(1)}% ≥ ${(verdict.threshold * 100).toFixed(0)}%.`
      : `Cleared — injection probability ${(verdict.injectionProbability * 100).toFixed(1)}%.`;
    securityStage.details = [
      `Adversarial question answered: ${verdict.present ? "yes" : "no"}`,
      `Injection probability: ${(verdict.injectionProbability * 100).toFixed(1)}%`,
      `Block threshold: ${(verdict.threshold * 100).toFixed(0)}%`,
      `Severity band: ${verdict.severity}`,
      `Cost: one extra answer inside the same request`,
    ];
  }

  /* --- Decisions + confidence ------------------------------------------- */
  const callerAnswers = omitKey(response.answers, ADVERSARIAL_CHECK_KEY);
  const decisions = toDecisions(callerAnswers, input.questions);
  const confidence = overallConfidence(decisions);
  const weakest = lowestConfidenceDecision(decisions);

  const intendedAction: CascadeAction = security.blocked
    ? "blocked"
    : confidenceBand(confidence, input.thresholds);

  stages.push({
    id: "confidence",
    label: "Confidence Threshold",
    status: security.blocked
      ? "bypassed"
      : intendedAction === "auto-act"
        ? "passed"
        : intendedAction === "generative-cascade"
          ? "escalated"
          : "warn",
    summary: `Lowest confidence ${(confidence * 100).toFixed(1)}% against cascade ${(input.thresholds.cascade * 100).toFixed(0)}% / auto-act ${(input.thresholds.autoAct * 100).toFixed(0)}%.`,
    details: [
      `Weakest signal: ${weakest ? `"${weakest.id}" at ${(weakest.confidence * 100).toFixed(1)}%` : "n/a"}`,
      ...decisions.map(
        (decision) =>
          `"${decision.id}" ${(decision.confidence * 100).toFixed(1)}% → ${confidenceBand(decision.confidence, input.thresholds)}`,
      ),
    ],
    durationMs: 0,
  });

  /* --- Cascade action --------------------------------------------------- */
  let action = intendedAction;
  let prose = renderProse(decisions);
  let proseSource: "template" | "gemini" = "template";
  const actionDetails: string[] = [];
  let actionStatus: StageStatus = "passed";

  if (action === "blocked") {
    prose = "";
    actionStatus = "blocked";
    actionDetails.push("Run blocked by the dual security gate.");
    actionDetails.push("No generative model was invoked.");
  } else if (action === "auto-act") {
    actionDetails.push(
      `Confidence ${(confidence * 100).toFixed(1)}% ≥ auto-act ${(input.thresholds.autoAct * 100).toFixed(0)}% — acted without escalation.`,
    );
    actionDetails.push("Prose rendered deterministically from typed decisions.");
  } else if (action === "human-escalation") {
    actionStatus = "warn";
    actionDetails.push(
      `Confidence sits between ${(input.thresholds.cascade * 100).toFixed(0)}% and ${(input.thresholds.autoAct * 100).toFixed(0)}% — routed to a human reviewer.`,
    );
    actionDetails.push("Prose rendered deterministically from typed decisions.");
    actionDetails.push("Raise the question specificity to reach auto-act.");
  } else {
    // Generative cascade.
    actionDetails.push(
      `Confidence ${(confidence * 100).toFixed(1)}% < cascade ${(input.thresholds.cascade * 100).toFixed(0)}% — escalating to ${GEMINI_MODEL}.`,
    );

    const geminiKey = input.credentials.geminiApiKey;

    if (input.mode === "demo") {
      latency.geminiLatencyMs = 540 + (((seed >> 3) % 71) + 40);
      prose = simulateGeminiProse(decisions);
      proseSource = "gemini";
      usage.geminiInputTokens = Math.max(
        60,
        Math.round(estimateTokens(renderDecisionReport(decisions)) * 1.35),
      );
      usage.geminiOutputTokens = Math.max(48, Math.round(prose.length / 4));
      actionDetails.push("Demo mode — prose simulated locally, no Gemini call made.");
      actionStatus = "escalated";
    } else if (!geminiKey) {
      action = "human-escalation";
      actionStatus = "warn";
      actionDetails.push(
        "No GEMINI_API_KEY configured — downgraded to human escalation with template prose.",
      );
    } else {
      try {
        const router = new GeminiCascadeRouter(geminiKey, {
          model: GEMINI_MODEL,
          temperature: 0.3,
          maxOutputTokens: 512,
          timeoutMs: 30_000,
        });
        const geminiStarted = performance.now();
        const generation = await router.generate(
          buildCascadePrompt(workingState, decisions, renderDecisionReport(decisions)),
          GEMINI_SYSTEM_INSTRUCTION,
        );
        latency.geminiLatencyMs = performance.now() - geminiStarted;

        if (generation.text) {
          prose = generation.text;
          proseSource = "gemini";
          actionStatus = "escalated";
        } else {
          action = "human-escalation";
          actionStatus = "warn";
          actionDetails.push(
            "Gemini returned an empty completion — keeping the template prose.",
          );
        }

        usage.geminiInputTokens = generation.usage?.input_tokens ?? 0;
        usage.geminiOutputTokens = generation.usage?.output_tokens ?? 0;
      } catch (error) {
        action = "human-escalation";
        actionStatus = "warn";
        actionDetails.push(
          `Gemini escalation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        actionDetails.push("Fell back to deterministic template prose.");
      }
    }
  }

  actionDetails.push(`Prose source: ${proseSource}`);

  stages.push({
    id: "action",
    label: "Cascade Action",
    status: actionStatus,
    summary:
      action === "auto-act"
        ? "Auto-act"
        : action === "blocked"
          ? "Block"
          : action === "human-escalation"
            ? "Human escalation"
            : `Generative cascade → ${GEMINI_MODEL}`,
    details: actionDetails,
    durationMs: latency.geminiLatencyMs,
  });

  /* --- Assemble the record --------------------------------------------- */
  usage.jevInputTokens = response.usage.input_tokens;
  usage.jevOutputTokens = response.usage.output_tokens;
  usage.estimatedCostUsd = estimateCost(usage);

  latency.totalMs = performance.now() - runStarted;
  latency.enricherMs = enricherMs;

  return {
    id: runId,
    startedAt,
    mode: input.mode,
    status: security.blocked ? "blocked" : "ok",
    action,
    stages,
    answers: response.answers,
    decisions,
    confidence,
    security,
    prose,
    proseSource,
    usage,
    latency,
    snapshot,
  };
}

function buildCascadePrompt(
  state: JevState,
  decisions: ReturnType<typeof toDecisions>,
  decisionReport: string,
): string {
  const stateText =
    typeof state === "string"
      ? state
      : (() => {
          try {
            return JSON.stringify(state, null, 2);
          } catch {
            return String(state);
          }
        })();

  return [
    "Jev resolved the following typed decisions for the state below.",
    "",
    "Resolved decisions:",
    decisionReport || "(none)",
    "",
    `Confidence per decision: ${decisions
      .map((decision) => `${decision.id}=${(decision.confidence * 100).toFixed(1)}%`)
      .join(", ")}`,
    "",
    "State (post-enrichment):",
    stateText,
    "",
    "Write the operational summary now.",
  ].join("\n");
}
