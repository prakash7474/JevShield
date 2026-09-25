import { z } from "zod";

import { JevResponseError, JevValidationError } from "../errors.js";
import type {
  JevAnswer,
  JevQuestions,
  JevResponse,
} from "../types/index.js";
import { JEV_LIMITS } from "../types/index.js";

/* -------------------------------------------------------------------------- *
 * Answers — validated strictly because we consume them.
 * -------------------------------------------------------------------------- */

const probabilityMap = z.record(z.string(), z.number());

export const noulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: z.number(),
});

export const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: probabilityMap,
  confidence: z.number(),
});

export const scoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  legend: z.record(z.string(), z.string()),
  probabilities: probabilityMap,
  confidence: z.number(),
});

export const jevAnswerSchema = z.discriminatedUnion("type", [
  noulAnswerSchema,
  choiceAnswerSchema,
  scoreAnswerSchema,
]);

export const jevUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});

export const jevResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), jevAnswerSchema),
  // Tolerate a missing usage block rather than discarding a valid answer set.
  usage: jevUsageSchema.default({ input_tokens: 0, output_tokens: 0 }),
});

export type ParsedJevResponse = z.infer<typeof jevResponseSchema>;

/* -------------------------------------------------------------------------- *
 * Questions — structural checks plus the hard API limits Jev will not patch.
 * -------------------------------------------------------------------------- */

const instructionsSchema = z.union([
  z.string(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

export const noulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: instructionsSchema,
  criteria: z
    .object({
      true: instructionsSchema.optional(),
      false: instructionsSchema.optional(),
    })
    .optional(),
});

export const choiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: instructionsSchema,
  criteria: z.record(z.string(), instructionsSchema.nullable()),
});

export const scoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: instructionsSchema,
  criteria: z.array(instructionsSchema),
});

export const jevQuestionSchema = z.discriminatedUnion("type", [
  noulQuestionSchema,
  choiceQuestionSchema,
  scoreQuestionSchema,
]);

function fail(message: string, details?: unknown): never {
  throw new JevValidationError(message, details);
}

/**
 * Validates all questions and enforces Jev's documented hard limits (255
 * choice options, 2–10 score levels) before a request is spent on them.
 *
 * @returns The same map, for convenient chaining.
 */
export function validateQuestions(questions: JevQuestions): JevQuestions {
  const ids = Object.keys(questions ?? {});
  if (ids.length === 0) {
    fail("At least one question is required.");
  }

  for (const id of ids) {
    if (!id) fail("Question ids must be non-empty strings.");
    const parsed = jevQuestionSchema.safeParse(questions[id]);
    if (!parsed.success) {
      fail(`Question "${id}" is malformed.`, parsed.error.issues);
    }

    const question = questions[id];
    if (question?.type === "choice") {
      const options = Object.keys(question.criteria ?? {});
      if (options.length === 0) {
        fail(`Choice question "${id}" must define at least one option.`);
      }
      if (options.length > JEV_LIMITS.maxChoiceOptions) {
        fail(
          `Choice question "${id}" defines ${options.length} options, but Jev accepts at most ${JEV_LIMITS.maxChoiceOptions}.`,
        );
      }
    }

    if (question?.type === "score") {
      const levels = question.criteria?.length ?? 0;
      if (levels < JEV_LIMITS.minScoreLevels || levels > JEV_LIMITS.maxScoreLevels) {
        fail(
          `Score question "${id}" defines ${levels} levels; Jev requires between ${JEV_LIMITS.minScoreLevels} and ${JEV_LIMITS.maxScoreLevels}.`,
        );
      }
    }
  }

  return questions;
}

/**
 * Parses and validates an unknown response body. Throws
 * {@link JevResponseError} with the offending issues on mismatch.
 */
export function parseJevResponse(data: unknown): JevResponse {
  const parsed = jevResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new JevResponseError(
      "TypeSafe returned a response that does not match the documented answer schema.",
      parsed.error.issues,
    );
  }
  return parsed.data as JevResponse;
}

/** Normalizes an answer's probabilities/confidence for downstream rendering. */
export function answerConfidence(answer: JevAnswer): number {
  if (answer.type === "noul") {
    const probability = Math.min(1, Math.max(0, answer.noul));
    return Math.max(probability, 1 - probability);
  }
  return Math.min(1, Math.max(0, answer.confidence));
}
