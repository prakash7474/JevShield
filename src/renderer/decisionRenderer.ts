import type {
  JevAnswer,
  JevAnswers,
  JevDecision,
  JevQuestion,
  JevQuestions,
  JevScoreAnswer,
} from "../types/index.js";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function probability(value: number): string {
  return clamp01(value).toFixed(3);
}

function nearestLevel(answer: JevScoreAnswer): { index: number; label?: string } {
  const indices = Object.keys(answer.legend)
    .map((key) => Number(key))
    .filter((key) => Number.isFinite(key));
  const max = indices.length > 0 ? Math.max(...indices) : 0;
  const index = Math.min(max, Math.max(0, Math.round(answer.score)));
  const label = answer.legend[String(index)];
  return label === undefined ? { index } : { index, label };
}

/**
 * Flattens a typed answer into a normalized, renderable decision. This is the
 * single place where Jev's three answer shapes are reconciled, so downstream
 * code never has to branch on `answer.type`.
 */
export function normalizeAnswer(
  id: string,
  answer: JevAnswer,
  question?: JevQuestion,
): JevDecision {
  const base = question ? { question } : {};

  switch (answer.type) {
    case "noul": {
      const yes = clamp01(answer.noul);
      return {
        id,
        type: "noul",
        value: yes,
        probability: yes,
        label: yes >= 0.5 ? "yes" : "no",
        confidence: Math.max(yes, 1 - yes),
        probabilities: { yes, no: 1 - yes },
        answer,
        ...base,
      };
    }
    case "choice": {
      const chosen = answer.choice;
      const chosenProbability = answer.probabilities[chosen];
      return {
        id,
        type: "choice",
        value: chosen,
        label: chosen,
        ...(chosenProbability === undefined ? {} : { probability: chosenProbability }),
        confidence: clamp01(answer.confidence),
        probabilities: { ...answer.probabilities },
        answer,
        ...base,
      };
    }
    case "score": {
      const { index, label } = nearestLevel(answer);
      const levelProbability = answer.probabilities[String(index)];
      return {
        id,
        type: "score",
        value: answer.score,
        label: label ?? String(index),
        ...(levelProbability === undefined ? {} : { probability: levelProbability }),
        confidence: clamp01(answer.confidence),
        probabilities: { ...answer.probabilities },
        answer,
        ...base,
      };
    }
  }
}

/** Normalizes a full answers map, joining each answer with its question. */
export function toDecisions(
  answers: JevAnswers,
  questions?: JevQuestions,
): JevDecision[] {
  return Object.keys(answers)
    .sort()
    .map((id) => normalizeAnswer(id, answers[id] as JevAnswer, questions?.[id]));
}

/** Single-line, log-friendly rendering of one decision. */
export function renderDecision(decision: JevDecision): string {
  switch (decision.type) {
    case "noul":
      return `${decision.label} (p=${probability(decision.value as number)}, confidence=${probability(decision.confidence)})`;
    case "choice": {
      const alternatives = Object.entries(decision.probabilities)
        .filter(([option]) => option !== decision.value)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([option, p]) => `${option}=${probability(p)}`);
      const runnerUp =
        alternatives.length > 0 ? `; runner-up: ${alternatives.join(", ")}` : "";
      return `"${decision.value}" (p=${probability(decision.probability ?? decision.confidence)}, confidence=${probability(decision.confidence)}${runnerUp})`;
    }
    case "score": {
      const levels = Object.keys(decision.answer.type === "score" ? decision.answer.legend : {});
      const max = Math.max(0, levels.length - 1);
      return `${decision.value} of ${max} ("${decision.label}", p=${probability(decision.probability ?? decision.confidence)}, confidence=${probability(decision.confidence)})`;
    }
  }
}

/** Bullet-list report over a set of decisions, one line per question id. */
export function renderDecisionReport(decisions: JevDecision[]): string {
  return decisions
    .map((decision) => `- ${decision.id} → ${renderDecision(decision)}`)
    .join("\n");
}

/** Natural-language sentence for one decision. */
export function renderDecisionSentence(decision: JevDecision): string {
  switch (decision.type) {
    case "noul":
      return `"${decision.id}" resolved to ${decision.label} with probability ${probability(decision.value as number)}.`;
    case "choice":
      return `"${decision.id}" resolved to "${decision.value}" with probability ${probability(decision.probability ?? decision.confidence)} (confidence ${probability(decision.confidence)}).`;
    case "score":
      return `"${decision.id}" scored ${decision.value} ("${decision.label}") with confidence ${probability(decision.confidence)}.`;
  }
}

/**
 * Deterministic prose rendering of a decision set — the patch for Jev's
 * inability to produce free-form text (weakness #4). No model call, no
 * randomness: the same answers always produce the same prose.
 */
export function renderProse(
  decisions: JevDecision[],
  options: { prefix?: string } = {},
): string {
  if (decisions.length === 0) return options.prefix ?? "";
  const body = decisions.map(renderDecisionSentence).join(" ");
  return options.prefix ? `${options.prefix} ${body}` : body;
}

/** Lowest confidence across a decision set — the escalation signal. */
export function overallConfidence(decisions: JevDecision[]): number {
  if (decisions.length === 0) return 1;
  return decisions.reduce(
    (lowest, decision) => Math.min(lowest, decision.confidence),
    1,
  );
}

/** The decision that should drive a confidence-based escalation. */
export function lowestConfidenceDecision(
  decisions: JevDecision[],
): JevDecision | undefined {
  return decisions.reduce<JevDecision | undefined>(
    (lowest, decision) =>
      lowest === undefined || decision.confidence < lowest.confidence
        ? decision
        : lowest,
    undefined,
  );
}
