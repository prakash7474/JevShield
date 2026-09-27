import type { JevQuestions } from "@jevshield/core";

import type {
  ChatMessage,
  ChatReply,
  Credentials,
  RunRecord,
  StudioMode,
  Thresholds,
} from "../types";
import { runPipeline } from "./engineClient";
import { computeEnrichedState } from "./enrichmentPreview";

/**
 * Prior turns that ride along with the current message so Jev decides against
 * the conversation rather than one isolated line.
 */
const MAX_TRANSCRIPT_TURNS = 16;

export interface ChatTurnInput {
  /** The message being answered. */
  message: string;
  /** Everything said before it, oldest first. */
  history: ChatMessage[];
  questions: JevQuestions;
  guardrailsEnabled: boolean;
  thresholds: Thresholds;
  model: string;
  credentials: Credentials;
  mode: StudioMode;
  runIndex: number;
}

export interface ChatAnswer {
  /** Rendered prose shown in the assistant bubble. */
  content: string;
  /** The structured decisions the prose was rendered from. */
  reply: ChatReply;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Wraps a chat turn as a Jev state payload. The transcript rides along so the
 * decisions account for the whole conversation, and the payload deliberately
 * carries a date and an array so the state enricher has something to derive.
 */
export function buildChatStateText(
  input: Pick<ChatTurnInput, "message" | "history">,
): string {
  const transcript = input.history
    .filter((entry) => entry.content.trim().length > 0)
    .slice(-MAX_TRANSCRIPT_TURNS)
    .map((entry) => ({ role: entry.role, content: entry.content }));

  return JSON.stringify(
    {
      message: input.message,
      channel: "studio-chat",
      sent_at: new Date().toISOString(),
      transcript,
    },
    null,
    2,
  );
}

/**
 * Turns a pipeline record into something a human wants to read. The blocked and
 * error paths are spelled out rather than leaving the bubble empty.
 */
function composeReply(record: RunRecord): string {
  if (record.status === "blocked") {
    return [
      "I stopped before deciding anything.",
      `The adversarial guardrail scored this state at ${percent(record.security.injectionProbability)} injection probability, at or above the ${percent(record.security.threshold)} block threshold, so no generative model was invoked.`,
      "Rephrase the message without instructions aimed at the model and I will evaluate it normally.",
    ].join(" ");
  }

  if (record.error) {
    return `I could not complete that evaluation: ${record.error}`;
  }

  const prose = record.prose.trim();
  if (prose.length > 0) return prose;

  return "I had no typed questions to resolve against that message, so there is nothing to report. Add questions in the Workbench, then send it again.";
}

function toReply(record: RunRecord, enrichedState: unknown | null): ChatReply {
  return {
    action: record.action,
    confidence: record.confidence,
    decisions: record.decisions,
    security: record.security,
    stages: record.stages,
    enrichedState,
    totalMs: record.latency.totalMs,
    jevLatencyMs: record.latency.jevLatencyMs,
    geminiLatencyMs: record.latency.geminiLatencyMs,
    model: record.snapshot.model,
    mode: record.mode,
    proseSource: record.proseSource,
    usage: record.usage,
    blocked: record.status === "blocked",
    error: record.error,
  };
}

/**
 * Answers one chat turn by running the same pipeline the workbench uses, so the
 * chat gets real decisions, real guardrails and real latency rather than a mock.
 */
export async function requestChatReply(
  input: ChatTurnInput,
): Promise<ChatAnswer> {
  const stateText = buildChatStateText(input);

  // The pipeline enriches this same string moments later, so re-deriving it here
  // gives the turn's disclosure panel the payload Jev actually saw.
  const enriched = computeEnrichedState(stateText);

  const record = await runPipeline({
    stateText,
    questions: input.questions,
    guardrailsEnabled: input.guardrailsEnabled,
    thresholds: input.thresholds,
    model: input.model,
    credentials: input.credentials,
    mode: input.mode,
    runIndex: input.runIndex,
  });

  return {
    content: composeReply(record),
    reply: toReply(record, enriched.ok ? enriched.value : null),
  };
}
