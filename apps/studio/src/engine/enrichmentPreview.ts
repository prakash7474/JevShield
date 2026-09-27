import {
  DEFAULT_MAX_INPUT_TOKENS,
  ENRICHMENT_KEY,
  enrichState,
  estimateTokens,
  type EnrichmentDerived,
} from "@jevshield/core";

import type { EnrichmentPreview } from "../types";

/** The post-enrichment payload, plus why it could not be produced. */
export interface EnrichedStateView {
  ok: boolean;
  error: string | null;
  /** False for string/array roots, which the enricher passes through untouched. */
  isObjectState: boolean;
  /** The payload as it would be sent to Jev, `__jevshield` block included. */
  value: unknown;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function byPath(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * Runs the real `enrichState` pre-processor over a state string and hands back
 * the payload it produced — the same call the pipeline makes, minus the run, so
 * a caller can show exactly what Jev was given.
 */
export function computeEnrichedState(stateText: string): EnrichedStateView {
  const empty: EnrichedStateView = {
    ok: false,
    error: null,
    isObjectState: false,
    value: null,
  };

  if (!stateText.trim()) return { ...empty, error: "State is empty." };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stateText);
  } catch (error) {
    return { ...empty, error: messageOf(error) };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: true, error: null, isObjectState: false, value: parsed };
  }

  try {
    const enriched = enrichState(parsed as Record<string, unknown>, undefined, {
      now: new Date(),
      maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
    });
    return { ok: true, error: null, isObjectState: true, value: enriched };
  } catch (error) {
    return { ...empty, error: messageOf(error) };
  }
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

  const view = computeEnrichedState(stateText);
  if (!view.ok) return { ...base, error: view.error };
  if (!view.isObjectState) return { ...base, ok: true };

  const derived = (view.value as Record<string, unknown>)[ENRICHMENT_KEY] as
    | EnrichmentDerived
    | undefined;
  if (!derived) return { ...base, ok: true, isObjectState: true };

  return {
    ok: true,
    error: null,
    isObjectState: true,
    estimatedTokens: estimateTokens(view.value),
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
}
