import { describe, expect, it } from "vitest";

import type { EnrichmentDerived } from "../types/index.js";
import { ENRICHMENT_KEY, enrichState, estimateTokens } from "./stateEnricher.js";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const DAY = 86_400_000;

function derivedOf(state: Record<string, unknown>): EnrichmentDerived {
  return state[ENRICHMENT_KEY] as EnrichmentDerived;
}

describe("enrichState", () => {
  it("is byte-for-byte deterministic for a fixed reference instant", () => {
    const state = {
      customer: { created_at: "2026-09-20T12:00:00.000Z", name: "Ada" },
      items: [10, 20, 30],
      events: [{ at: "2026-09-24T12:00:00.000Z" }],
    };

    const first = enrichState(state, undefined, { now: NOW });
    const second = enrichState(state, undefined, { now: NOW });

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("derives elapsed days from ISO date strings", () => {
    const result = enrichState(
      { created_at: "2026-09-20T12:00:00.000Z" },
      undefined,
      { now: NOW },
    );

    const derived = derivedOf(result);
    expect(derived.dates["created_at"]?.elapsed_days).toBe(5);
    expect(derived.dates["created_at"]?.elapsed_hours).toBe(120);
    expect(derived.dates["created_at"]?.direction).toBe("past");
    expect(derived.dates["created_at"]?.iso).toBe("2026-09-20T12:00:00.000Z");
  });

  it("marks future instants and leaves non-date strings alone", () => {
    const result = enrichState(
      { expires_at: "2026-10-05T12:00:00.000Z", title: "2026 is the year" },
      undefined,
      { now: NOW },
    );

    const derived = derivedOf(result);
    expect(derived.dates["expires_at"]?.elapsed_days).toBe(-10);
    expect(derived.dates["expires_at"]?.direction).toBe("future");
    expect(derived.dates["title"]).toBeUndefined();
  });

  it("derives dates from epoch seconds on date-like keys", () => {
    const epochSeconds = Math.floor(NOW.getTime() / 1_000) - 3 * 86_400;
    const result = enrichState({ order_placed_at: epochSeconds }, undefined, {
      now: NOW,
    });

    expect(derivedOf(result).dates["order_placed_at"]?.elapsed_days).toBe(3);
  });

  it("ignores epoch-looking numbers on keys that are not date-like", () => {
    const epochSeconds = Math.floor(NOW.getTime() / 1_000) - 3 * 86_400;
    const result = enrichState({ account_balance: epochSeconds }, undefined, {
      now: NOW,
    });

    expect(derivedOf(result).dates["account_balance"]).toBeUndefined();
  });

  it("counts array items and aggregates numeric arrays", () => {
    const result = enrichState(
      {
        items: [4, 8, 15, 16, 23, 42],
        nested: { tags: ["a", "b"] },
      },
      undefined,
      { now: NOW },
    );

    const derived = derivedOf(result);
    expect(derived.counts["items"]).toBe(6);
    expect(derived.counts["nested.tags"]).toBe(2);
    expect(derived.stats["items"]).toEqual({
      count: 6,
      sum: 108,
      min: 4,
      max: 42,
      mean: 18,
      median: 15.5,
    });
    expect(derived.stats["nested.tags"]).toBeUndefined();
  });

  it("computes signed day deltas between date fields", () => {
    const result = enrichState(
      {
        created_at: "2026-09-20T12:00:00.000Z",
        updated_at: "2026-09-24T12:00:00.000Z",
      },
      undefined,
      { now: NOW },
    );

    expect(derivedOf(result).date_differences["created_at->updated_at"]).toBe(4);
  });

  it("namespaces custom calculators so they cannot clobber derived facts", () => {
    const result = enrichState(
      { items: [1, 2, 3] },
      (state) => ({
        itemCount: Array.isArray(state["items"]) ? state["items"].length : 0,
      }),
      { now: NOW },
    );

    expect(derivedOf(result).custom["custom"]).toEqual({ itemCount: 3 });
  });

  it("accepts a named map and an array of calculators", () => {
    const mapped = enrichState(
      { items: [1, 2, 3] },
      {
        total: (state) => ({
          total: (state["items"] as number[]).reduce((a, b) => a + b, 0),
        }),
      },
      { now: NOW },
    );
    expect(derivedOf(mapped).custom["total"]).toEqual({ total: 6 });

    const arrayed = enrichState(
      { items: [1, 2, 3] },
      [() => ({ a: 1 }), () => ({ b: 2 })],
      { now: NOW },
    );
    expect(derivedOf(arrayed).custom).toEqual({
      custom_0: { a: 1 },
      custom_1: { b: 2 },
    });
  });

  it("preserves the original payload and never mutates the input", () => {
    const state = { customer: { name: "Ada" }, items: [1, 2, 3] };
    const result = enrichState(state, undefined, { now: NOW });

    expect(result["customer"]).toEqual({ name: "Ada" });
    expect(result["items"]).toEqual([1, 2, 3]);
    expect(Object.keys(state)).toEqual(["customer", "items"]);
  });

  it("truncates an oversized state to fit the token budget", () => {
    const state = {
      note: "x".repeat(400_000),
      items: Array.from({ length: 40 }, (_, index) => index),
    };

    const result = enrichState(state, undefined, {
      now: NOW,
      maxInputTokens: 600,
    });
    const derived = derivedOf(result);

    expect(derived.truncation.applied).toBe(true);
    expect(derived.truncation.strategy).toBe("string-cap");
    expect(estimateTokens(result)).toBeLessThanOrEqual(600);
    expect(String(result["note"])).toContain("truncated");
  });

  it("hard-truncates when even the derived envelope exceeds the budget", () => {
    const state: Record<string, unknown> = {};
    for (let index = 0; index < 6; index += 1) {
      state[`event_${index}_at`] = new Date(
        NOW.getTime() - index * DAY,
      ).toISOString();
    }

    const result = enrichState(state, undefined, {
      now: NOW,
      maxInputTokens: 120,
    });
    const derived = derivedOf(result);

    expect(derived.truncation.strategy).toBe("hard-truncate");
    expect(derived.truncation.finalTokens).toBeLessThanOrEqual(120);
  });

  it("throws when strictTokenBudget is enabled and the state is too large", () => {
    expect(() =>
      enrichState(
        { note: "y".repeat(200_000) },
        undefined,
        { now: NOW, maxInputTokens: 100, strictTokenBudget: true },
      ),
    ).toThrow(/token budget/i);
  });

  it("tolerates circular references", () => {
    const node: Record<string, unknown> = { name: "root" };
    node["self"] = node;

    const result = enrichState(node, undefined, {
      now: NOW,
      maxInputTokens: 2_000,
    });

    expect(estimateTokens(result)).toBeLessThanOrEqual(2_000);
  });
});
