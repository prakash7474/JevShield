import { JEV_LIMITS, type JevQuestion, type JevQuestions } from "@jevshield/core";

import type { QuestionKind } from "../types";

export const QUESTION_KINDS: QuestionKind[] = ["noul", "choice", "score"];

export const QUESTION_KIND_LABEL: Record<QuestionKind, string> = {
  noul: "Noul",
  choice: "Choice",
  score: "Score",
};

export const QUESTION_KIND_BLURB: Record<QuestionKind, string> = {
  noul: "Yes/no statement. Jev returns the probability the answer is yes.",
  choice: "Pick one option from a rubric map. Returns the label plus the full distribution.",
  score: "Ordered rubric rating. Returns a probability-weighted value between levels.",
};

export interface QuestionIssue {
  level: "error" | "warning";
  message: string;
}

const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function createQuestion(kind: QuestionKind): JevQuestion {
  switch (kind) {
    case "noul":
      return {
        type: "noul",
        instructions: "Does the state satisfy this condition?",
        criteria: { true: "It does", false: "It does not" },
      };
    case "choice":
      return {
        type: "choice",
        instructions: "Which option best applies to this state?",
        criteria: {
          option_a: "First option rubric",
          option_b: "Second option rubric",
        },
      };
    case "score":
      return {
        type: "score",
        instructions: "How would you rate this state on the rubric?",
        criteria: ["Low", "Medium", "High"],
      };
  }
}

export function uniqueQuestionId(
  questions: JevQuestions,
  base = "new_question",
): string {
  if (!questions[base]) return base;
  let index = 2;
  while (questions[`${base}_${index}`]) index += 1;
  return `${base}_${index}`;
}

export function isValidQuestionId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/**
 * Validates one question. Note that exceeding 255 Choice options is a warning,
 * not an error: the tree chunker splits it into several requests.
 */
export function questionIssues(
  id: string,
  question: JevQuestion,
): QuestionIssue[] {
  const issues: QuestionIssue[] = [];

  if (!id.trim()) {
    issues.push({ level: "error", message: "Question id is required." });
  } else if (!isValidQuestionId(id)) {
    issues.push({
      level: "error",
      message:
        "Ids must start with a letter or underscore and contain only letters, digits and underscores.",
    });
  }

  if (
    typeof question.instructions === "string" &&
    question.instructions.trim().length === 0
  ) {
    issues.push({ level: "error", message: "Instructions are required." });
  }

  if (question.type === "choice") {
    const count = Object.keys(question.criteria ?? {}).length;
    if (count === 0) {
      issues.push({ level: "error", message: "Add at least one option." });
    } else if (count > JEV_LIMITS.maxChoiceOptions) {
      issues.push({
        level: "warning",
        message: `${count} options exceeds Jev's ${JEV_LIMITS.maxChoiceOptions}-option ceiling — the tree chunker will split this into ${Math.ceil(count / JEV_LIMITS.maxChoiceOptions)} requests.`,
      });
    }
    const emptyRubrics = Object.values(question.criteria ?? {}).filter(
      (rubric) => rubric === null || rubric === undefined,
    ).length;
    if (emptyRubrics > 0) {
      issues.push({
        level: "warning",
        message: `${emptyRubrics} option(s) have no rubric description, which lowers answer quality.`,
      });
    }
  }

  if (question.type === "score") {
    const levels = question.criteria?.length ?? 0;
    if (levels < JEV_LIMITS.minScoreLevels) {
      issues.push({
        level: "error",
        message: `Score questions need at least ${JEV_LIMITS.minScoreLevels} levels.`,
      });
    } else if (levels > JEV_LIMITS.maxScoreLevels) {
      issues.push({
        level: "error",
        message: `Score questions accept at most ${JEV_LIMITS.maxScoreLevels} levels.`,
      });
    }
  }

  return issues;
}

export function hasBlockingIssue(issues: QuestionIssue[]): boolean {
  return issues.some((issue) => issue.level === "error");
}

/** Issues for the whole question set, keyed by question id. */
export function collectQuestionIssues(
  questions: JevQuestions,
): Array<{ id: string; issues: QuestionIssue[] }> {
  return Object.entries(questions).map(([id, question]) => ({
    id,
    issues: questionIssues(id, question),
  }));
}
