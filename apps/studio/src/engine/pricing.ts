import type { RunUsage } from "../types";

/**
 * Token pricing used purely for the cost column in the trajectory log.
 *
 * These are editable placeholders in USD per million tokens, not scraped
 * published rates — change them to match your contract before trusting the
 * cost numbers.
 */
export const PRICING = {
  jev: { inputPerMTok: 2.5, outputPerMTok: 10 },
  geminiFlash: { inputPerMTok: 0.3, outputPerMTok: 2.5 },
} as const;

export function estimateCost(input: {
  jevInputTokens: number;
  jevOutputTokens: number;
  geminiInputTokens: number;
  geminiOutputTokens: number;
}): number {
  const perMillion = 1_000_000;
  return (
    (input.jevInputTokens / perMillion) * PRICING.jev.inputPerMTok +
    (input.jevOutputTokens / perMillion) * PRICING.jev.outputPerMTok +
    (input.geminiInputTokens / perMillion) * PRICING.geminiFlash.inputPerMTok +
    (input.geminiOutputTokens / perMillion) * PRICING.geminiFlash.outputPerMTok
  );
}

export function emptyUsage(): RunUsage {
  return {
    jevInputTokens: 0,
    jevOutputTokens: 0,
    geminiInputTokens: 0,
    geminiOutputTokens: 0,
    estimatedCostUsd: 0,
  };
}
