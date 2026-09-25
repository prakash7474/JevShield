import {
  JEV_LIMITS,
  type JevChoiceAnswer,
  type JevChoiceQuestion,
  type JevInstructions,
  type JevQuestions,
} from "@jevshield/core";

import { argmax, distributionConfidence, normalizeDistribution } from "./probability";

/**
 * Jev accepts at most 255 options per Choice question. The tree chunker splits
 * an oversized Choice into several requests that each evaluate the same
 * decision against a disjoint slice of the options, then merges the resulting
 * distributions back into one answer.
 */
export interface ChoiceChunk {
  /** Option labels covered by this chunk, in the original declaration order. */
  options: string[];
  /** Ready-to-send question restricted to {@link options}. */
  question: JevChoiceQuestion;
}

export interface ChunkGroup {
  questionId: string;
  totalOptions: number;
  chunks: ChoiceChunk[];
}

export interface ChunkPlan {
  required: boolean;
  maxOptionsPerChunk: number;
  groups: ChunkGroup[];
  totalChunks: number;
}

/** Splits one oversized Choice question into sendable sub-questions. */
export function chunkChoiceQuestion(
  question: JevChoiceQuestion,
  maxOptions: number = JEV_LIMITS.maxChoiceOptions,
): ChoiceChunk[] {
  const options = Object.keys(question.criteria ?? {});
  const chunks: ChoiceChunk[] = [];

  for (let start = 0; start < options.length; start += maxOptions) {
    const slice = options.slice(start, start + maxOptions);
    const criteria: Record<string, JevInstructions | null> = {};
    for (const option of slice) {
      criteria[option] = question.criteria[option] ?? null;
    }
    chunks.push({
      options: slice,
      question: {
        type: "choice",
        instructions: question.instructions,
        criteria,
      },
    });
  }

  return chunks;
}

/** Plans chunking for a whole question set. A no-op when nothing is oversized. */
export function planChunks(
  questions: JevQuestions,
  maxOptions: number = JEV_LIMITS.maxChoiceOptions,
): ChunkPlan {
  const groups: ChunkGroup[] = [];

  for (const [questionId, question] of Object.entries(questions)) {
    if (question.type !== "choice") continue;
    const totalOptions = Object.keys(question.criteria ?? {}).length;
    if (totalOptions <= maxOptions) continue;

    groups.push({
      questionId,
      totalOptions,
      chunks: chunkChoiceQuestion(question, maxOptions),
    });
  }

  return {
    required: groups.length > 0,
    maxOptionsPerChunk: maxOptions,
    groups,
    totalChunks: groups.reduce((total, group) => total + group.chunks.length, 0),
  };
}

/**
 * Merges per-chunk Choice answers into a single answer.
 *
 * Each chunk returns a distribution normalized over its own slice. Summing the
 * slices and dividing by the chunk count yields a distribution over the full
 * option set: every chunk carries equal prior weight, and options outside a
 * chunk contribute zero from it.
 */
export function mergeChunkedChoice(
  chunkAnswers: Array<{ options: string[]; answer: JevChoiceAnswer }>,
): JevChoiceAnswer {
  if (chunkAnswers.length === 0) {
    return { type: "choice", choice: "", probabilities: {}, confidence: 0 };
  }

  const [first] = chunkAnswers;
  if (first && chunkAnswers.length === 1) return first.answer;

  const totals: Record<string, number> = {};
  for (const { options, answer } of chunkAnswers) {
    for (const option of options) {
      totals[option] = (totals[option] ?? 0) + (answer.probabilities[option] ?? 0);
    }
  }

  // Each chunk carries equal prior weight over the full option set.
  const divisor = chunkAnswers.length;
  const averaged: Record<string, number> = {};
  for (const [option, value] of Object.entries(totals)) {
    averaged[option] = value / divisor;
  }

  const probabilities = normalizeDistribution(averaged);
  const winner = argmax(probabilities);

  return {
    type: "choice",
    choice: winner.key,
    probabilities,
    confidence: distributionConfidence(Object.values(probabilities)),
  };
}
