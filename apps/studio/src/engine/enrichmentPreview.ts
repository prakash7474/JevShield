import {
  DEFAULT_MAX_INPUT_TOKENS,
  ENRICHMENT_KEY,
  enrichState,
  estimateTokens,
  type EnrichmentDerived,
} from "@jevshield/core";

import type { EnrichmentPreview } from "../types";

function byPath(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * Runs the real `enrichState` pre-processor against the editor contents so the
 * preview always reflects what the pipeline would actually send to Jev.
 */
export function computeEnrichmentPreview(stateText: string): EnrichmentPreview {
  const base: EnrichmentPreview = {
    ok: false,
    error: null,
    isObjectState: false,
    estimatedTokens: estimateTokens(stateText),
    applied: false,
    strategy: "none",
    dates: [],
    counts: [],
    stats: [],
    dateDifferences: [],
  };

  if (!stateText.trim()) {
    return { ...base, error: "State is empty." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stateText);
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...base, ok: true };
  }

  try {
    const enriched = enrichState(
      parsed as Record<string, unknown>,
      undefined,
      { now: new Date(), maxInputTokens: DEFAULT_MAX_INPUT_TOKENS },
    );

    const derived = enriched[ENRICHMENT_KEY] as EnrichmentDerived | undefined;
    if (!derived) return { ...base, ok: true, isObjectState: true };

    return {
      ok: true,
      error: null,
      isObjectState: true,
      estimatedTokens: estimateTokens(enriched),
      applied: derived.truncation.applied,
      strategy: derived.truncation.strategy,
      dates: Object.keys(derived.dates)
        .sort(byPath)
        .map((path) => {
          const entry = derived.dates[path];
          return {
            path,
            iso: entry?.iso ?? "",
            elapsedDays: entry?.elapsed_days ?? 0,
            direction: entry?.direction ?? "now",
          };
        }),
      counts: Object.keys(derived.counts)
        .sort(byPath)
        .map((path) => ({ path, count: derived.counts[path] ?? 0 })),
      stats: Object.keys(derived.stats)
        .sort(byPath)
        .map((path) => {
          const stats = derived.stats[path];
          return {
            path,
            count: stats?.count ?? 0,
            sum: stats?.sum ?? 0,
            min: stats?.min ?? 0,
            max: stats?.max ?? 0,
            mean: stats?.mean ?? 0,
            median: stats?.median ?? 0,
          };
        }),
      dateDifferences: Object.keys(derived.date_differences)
        .sort(byPath)
        .map((pair) => ({
          pair,
          days: derived.date_differences[pair] ?? 0,
        })),
    };
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
