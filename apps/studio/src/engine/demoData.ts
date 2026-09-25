import {
  ADVERSARIAL_CHECK_KEY,
  estimateTokens,
  type JevAnswers,
  type JevDecision,
  type JevResponse,
  type JevQuestions,
} from "@jevshield/core";

import { argmax, clamp01, distributionConfidence, round } from "./probability";

/* -------------------------------------------------------------------------- *
 * Deterministic pseudo-randomness
 * -------------------------------------------------------------------------- */

export function hashString(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Small, fast, seedable PRNG so simulated runs are reproducible. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draws weights from the PRNG and normalizes them into a probability
 * distribution. Higher `sharpness` produces a more peaked (confident) result.
 */
function drawDistribution(
  rng: () => number,
  count: number,
  sharpness: number,
): number[] {
  if (count <= 0) return [];
  const weights = Array.from({ length: count }, () =>
    Math.pow(rng() + 0.015, sharpness),
  );
  let total = 0;
  for (const weight of weights) total += weight;
  if (total <= 0) return weights.map(() => round(1 / count));
  return weights.map((weight) => round(weight / total));
}

/* -------------------------------------------------------------------------- *
 * Injection heuristic
 * -------------------------------------------------------------------------- */

const INJECTION_MARKERS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)/i,
  /disregard\s+(all\s+)?(previous|prior|above|the)/i,
  /system\s+prompt/i,
  /jailbreak/i,
  /you\s+are\s+now/i,
  /override\s+(the\s+)?(policy|rules|instructions)/i,
  /\bact\s+as\s+(a|an)\b/i,
  /<\s*\/?\s*(script|system|instruction)/i,
  /mark\s+this\s+as\s+(low|no)\s+priority/i,
];

/**
 * Very rough lexical scan used only by demo mode so the simulated adversarial
 * score reacts to what is actually in the editor. Live mode uses Jev itself.
 */
export function injectionHeuristic(stateText: string): number {
  let hits = 0;
  for (const marker of INJECTION_MARKERS) {
    if (marker.test(stateText)) hits += 1;
  }
  return round(clamp01(0.06 + hits * 0.27), 3);
}

/* -------------------------------------------------------------------------- *
 * Jev simulation
 * -------------------------------------------------------------------------- */

export const DEMO_MODEL = "jev-demo-1.13.0";

/**
 * Produces a Jev-shaped response without touching the network, so the
 * workbench is fully usable before any credentials are entered. The output is
 * shaped exactly like the real API (including the injected adversarial answer)
 * so the rest of the pipeline runs unchanged.
 */
export function simulateJevResponse(
  questions: JevQuestions,
  stateText: string,
  seed: number,
): JevResponse {
  const rng = mulberry32(seed);
  const answers: JevAnswers = {};

  for (const id of Object.keys(questions).sort()) {
    const question = questions[id];
    if (!question) continue;

    if (id === ADVERSARIAL_CHECK_KEY) {
      answers[id] = { type: "noul", noul: injectionHeuristic(stateText) };
      continue;
    }

    if (question.type === "noul") {
      answers[id] = {
        type: "noul",
        noul: round(clamp01(0.05 + rng() * 0.92), 3),
      };
      continue;
    }

    if (question.type === "choice") {
      const options = Object.keys(question.criteria ?? {});
      if (options.length === 0) continue;

      // Oversized questions get a flatter distribution, mirroring how much
      // harder the decision is with a 300-way taxonomy.
      const sharpness = options.length > 255 ? 1.35 : 2.6;
      const drawn = drawDistribution(rng, options.length, sharpness);

      const probabilities: Record<string, number> = {};
      options.forEach((option, index) => {
        probabilities[option] = drawn[index] ?? 0;
      });

      answers[id] = {
        type: "choice",
        choice: argmax(probabilities).key,
        probabilities,
        confidence: distributionConfidence(drawn),
      };
      continue;
    }

    const levels = question.criteria ?? [];
    if (levels.length === 0) continue;

    const drawn = drawDistribution(rng, levels.length, 2.0);

    const legend: Record<string, string> = {};
    const probabilities: Record<string, number> = {};
    let expected = 0;

    levels.forEach((level, index) => {
      legend[String(index)] = typeof level === "string" ? level : `Level ${index}`;
      probabilities[String(index)] = drawn[index] ?? 0;
      expected += index * (drawn[index] ?? 0);
    });

    answers[id] = {
      type: "score",
      score: round(expected, 3),
      legend,
      probabilities,
      confidence: distributionConfidence(drawn),
    };
  }

  const inputTokens = Math.max(24, estimateTokens(stateText));
  const outputTokens = 14 + Object.keys(answers).length * 11;

  return {
    model: DEMO_MODEL,
    answers,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

/* -------------------------------------------------------------------------- *
 * Generative prose simulation
 * -------------------------------------------------------------------------- */

/**
 * Composes fallback prose from the resolved decisions. Used in demo mode so the
 * generative cascade produces something believable without a Gemini key. The
 * text is derived only from the decisions — it never invents facts.
 */
export function simulateGeminiProse(decisions: JevDecision[]): string {
  if (decisions.length === 0) {
    return "No typed questions were resolved for this state, so there is nothing to narrate.";
  }

  const sentences: string[] = [];
  const weakest = decisions.reduce((lowest, decision) =>
    decision.confidence < lowest.confidence ? decision : lowest,
  );

  sentences.push(
    `This request was resolved into ${decisions.length} typed decision${decisions.length === 1 ? "" : "s"}.`,
  );

  for (const decision of decisions) {
    if (decision.type === "noul") {
      sentences.push(
        `"${decision.id}" came back ${decision.label} at ${(Number(decision.value) * 100).toFixed(0)}% probability.`,
      );
    } else if (decision.type === "choice") {
      sentences.push(
        `"${decision.id}" routed to "${decision.value}" with ${((decision.probability ?? decision.confidence) * 100).toFixed(0)}% of the probability mass.`,
      );
    } else {
      sentences.push(
        `"${decision.id}" landed at ${decision.value} on its rubric ("${decision.label}").`,
      );
    }
  }

  sentences.push(
    `The weakest signal was "${weakest.id}" at ${(weakest.confidence * 100).toFixed(0)}% confidence, which is why this narrative was generated rather than acted on directly.`,
  );

  return sentences.join(" ");
}
