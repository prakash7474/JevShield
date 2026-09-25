export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Confidence proxy for a probability distribution: the winning probability
 * damped by how flat the distribution is. A peaked distribution scores near its
 * peak; a uniform one collapses toward zero.
 */
export function distributionConfidence(probabilities: readonly number[]): number {
  if (probabilities.length <= 1) return 1;

  const peak = Math.max(...probabilities);
  if (peak <= 0) return 0;

  let entropy = 0;
  for (const probability of probabilities) {
    if (probability > 0) entropy -= probability * Math.log(probability);
  }

  const maxEntropy = Math.log(probabilities.length);
  const flatness = maxEntropy === 0 ? 0 : entropy / maxEntropy;
  return clamp01(peak * (1 - flatness * 0.45));
}

/** Renormalizes a distribution so it sums to 1, absorbing float drift. */
export function normalizeDistribution(
  entries: Record<string, number>,
): Record<string, number> {
  const keys = Object.keys(entries);
  if (keys.length === 0) return {};

  let total = 0;
  for (const key of keys) total += entries[key] ?? 0;

  if (total <= 0) {
    const uniform = 1 / keys.length;
    const out: Record<string, number> = {};
    for (const key of keys) out[key] = round(uniform);
    return out;
  }

  const out: Record<string, number> = {};
  for (const key of keys) out[key] = round((entries[key] ?? 0) / total);
  return out;
}

export function argmax(entries: Record<string, number>): {
  key: string;
  value: number;
} {
  let key = "";
  let value = Number.NEGATIVE_INFINITY;
  for (const [candidate, candidateValue] of Object.entries(entries)) {
    if (candidateValue > value) {
      key = candidate;
      value = candidateValue;
    }
  }
  return { key, value: Number.isFinite(value) ? value : 0 };
}
