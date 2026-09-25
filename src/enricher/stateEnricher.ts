import { JevShieldError } from "../errors.js";
import type {
  CustomCalculator,
  CustomCalculatorContext,
  CustomCalculatorInput,
  DateDerivation,
  EnrichedState,
  EnrichStateOptions,
  EnrichmentDerived,
  NumericStats,
  TruncationReport,
} from "../types/index.js";
import { JEV_LIMITS } from "../types/index.js";

/**
 * Namespace under which every derived fact is injected. Kept inside the
 * `state` object so Jev can reference values such as
 * `` `__jevshield.dates.created_at.elapsed_days` `` from its instructions.
 */
export const ENRICHMENT_KEY = "__jevshield";

export const ENRICHMENT_SCHEMA_VERSION = "1.0.0";

/**
 * Default budget for a single evaluation. Leaves ~2k tokens of headroom under
 * Jev's documented 32k input ceiling for the questions map itself.
 */
export const DEFAULT_MAX_INPUT_TOKENS = JEV_LIMITS.maxInputTokens - 2_000;

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_SECOND = 1_000;

/** ISO-8601 calendar dates and date-times (the only string format we trust). */
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** Field names that make a bare number plausible as an epoch timestamp. */
const DATE_KEY_RE =
  /(^|_)(at|date|time|timestamp|expires|expiry|created|updated|start|end|deadline|due)(_|$)/i;

/** Upper bound on the number of date fields we compute pairwise deltas for. */
const MAX_DATE_PAIR_FIELDS = 20;

/* -------------------------------------------------------------------------- *
 * Small deterministic helpers
 * -------------------------------------------------------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function lastKey(path: string): string {
  const tail = path.split(".").pop() ?? path;
  return tail.replace(/\[\d+\]$/, "");
}

/**
 * Serializes a value with recursively sorted object keys so that the same
 * logical state always produces byte-identical output. Cycles are replaced
 * with a marker rather than throwing.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value, new WeakSet())) ?? "null";
}

function sortValue(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const out = value.map((item) => sortValue(item, seen));
    seen.delete(value);
    return out;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortValue(value[key], seen);
    }
    seen.delete(value);
    return out;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  return value;
}

/** Cheap, dependency-free token estimate (~4 characters per token). */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : stableStringify(value);
  return Math.ceil(text.length / 4);
}

/* -------------------------------------------------------------------------- *
 * Date detection
 * -------------------------------------------------------------------------- */

function toDate(value: unknown, key: string): Date | null {
  if (typeof value === "string" && ISO_DATE_RE.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    DATE_KEY_RE.test(key)
  ) {
    // Epoch seconds are < 1e12; anything larger is already milliseconds.
    const ms = value < 1e12 ? value * MS_PER_SECOND : value;
    // Reject implausible instants (roughly 2001-01-01 .. 2100-01-01).
    if (ms < 978_307_200_000 || ms > 4_102_444_800_000) return null;
    return new Date(ms);
  }
  return null;
}

function deriveDate(date: Date, nowMs: number): DateDerivation {
  const diffMs = nowMs - date.getTime();
  return {
    iso: date.toISOString(),
    elapsed_days: round(diffMs / MS_PER_DAY),
    elapsed_hours: round(diffMs / MS_PER_HOUR),
    elapsed_seconds: round(diffMs / MS_PER_SECOND),
    direction: diffMs > 0 ? "past" : diffMs < 0 ? "future" : "now",
  };
}

/* -------------------------------------------------------------------------- *
 * Numeric statistics
 * -------------------------------------------------------------------------- */

function numericStats(values: readonly unknown[]): NumericStats | null {
  if (values.length === 0) return null;
  const nums: number[] = [];
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    nums.push(value);
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = nums.reduce((acc, n) => acc + n, 0);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
      : (sorted[middle] as number);
  return {
    count: nums.length,
    sum: round(sum),
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
    mean: round(sum / nums.length),
    median: round(median),
  };
}

/* -------------------------------------------------------------------------- *
 * Traversal
 * -------------------------------------------------------------------------- */

interface Collected {
  dates: Record<string, DateDerivation>;
  counts: Record<string, number>;
  stats: Record<string, NumericStats>;
}

function collect(
  value: unknown,
  path: string,
  nowMs: number,
  opts: Required<
    Pick<EnrichStateOptions, "computeDateDifferences" | "computeStats">
  >,
  out: Collected,
  seen: WeakSet<object>,
): void {
  const date = toDate(value, lastKey(path));
  if (date) out.dates[path] = deriveDate(date, nowMs);

  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    out.counts[path] = value.length;
    if (opts.computeStats) {
      const stats = numericStats(value);
      if (stats) out.stats[path] = stats;
    }
    value.forEach((item, index) => {
      collect(item, `${path}[${index}]`, nowMs, opts, out, seen);
    });
    return;
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      collect(
        child,
        path === "" ? key : `${path}.${key}`,
        nowMs,
        opts,
        out,
        seen,
      );
    }
  }
}

/** Signed days between every pair of date fields (capped for large states). */
function buildDateDifferences(
  dates: Record<string, DateDerivation>,
): Record<string, number> {
  const paths = Object.keys(dates).sort();
  if (paths.length < 2) return {};

  const ms = (path: string): number =>
    Date.parse((dates[path] as DateDerivation).iso);

  const out: Record<string, number> = {};
  if (paths.length <= MAX_DATE_PAIR_FIELDS) {
    for (let i = 0; i < paths.length; i += 1) {
      for (let j = i + 1; j < paths.length; j += 1) {
        const from = paths[i] as string;
        const to = paths[j] as string;
        out[`${from}->${to}`] = round((ms(to) - ms(from)) / MS_PER_DAY);
      }
    }
    return out;
  }

  // Too many fields for a full matrix: anchor everything to the earliest.
  const earliest = paths.reduce((acc, p) => (ms(p) < ms(acc) ? p : acc));
  for (const path of paths) {
    if (path === earliest) continue;
    out[`${earliest}->${path}`] = round((ms(path) - ms(earliest)) / MS_PER_DAY);
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * Token budget enforcement
 * -------------------------------------------------------------------------- */

const STRING_CAPS = [4_096, 2_048, 1_024, 512, 256, 128, 64, 32, 16, 8];
const ARRAY_CAPS = [100, 50, 25, 10, 5, 3, 1];

function mapDeep(
  value: unknown,
  fn: (node: unknown) => unknown,
): unknown {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (isPlainObject(node)) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) out[key] = visit(child);
      return out;
    }
    return fn(node);
  };
  return visit(value);
}

function capStrings(value: unknown, cap: number): unknown {
  return mapDeep(value, (node) =>
    typeof node === "string" && node.length > cap
      ? `${node.slice(0, cap)}…[truncated]`
      : node,
  );
}

function capArrays(value: unknown, cap: number): unknown {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.slice(0, cap).map(visit);
    if (isPlainObject(node)) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) out[key] = visit(child);
      return out;
    }
    return node;
  };
  return visit(value);
}

function enforceTokenBudget(
  value: EnrichedState,
  maxTokens: number,
): { value: EnrichedState; report: TruncationReport } {
  const originalTokens = estimateTokens(value);
  const base = {
    estimatedTokens: originalTokens,
    finalTokens: originalTokens,
    maxTokens,
  };

  if (originalTokens <= maxTokens) {
    return { value, report: { ...base, applied: false, strategy: "none" } };
  }

  for (const cap of STRING_CAPS) {
    const candidate = capStrings(value, cap) as EnrichedState;
    const tokens = estimateTokens(candidate);
    if (tokens <= maxTokens) {
      return {
        value: candidate,
        report: {
          ...base,
          applied: true,
          strategy: "string-cap",
          finalTokens: tokens,
        },
      };
    }
  }

  for (const cap of ARRAY_CAPS) {
    const candidate = capArrays(capStrings(value, 8), cap) as EnrichedState;
    const tokens = estimateTokens(candidate);
    if (tokens <= maxTokens) {
      return {
        value: candidate,
        report: {
          ...base,
          applied: true,
          strategy: "array-cap",
          finalTokens: tokens,
        },
      };
    }
  }

  // Last resort: keep a minimal derived envelope and spend whatever budget is
  // left on a preview of the serialized state.
  const serialized = stableStringify(value);
  const envelope = value[ENRICHMENT_KEY];
  const meta = isPlainObject(envelope)
    ? {
        schema_version:
          envelope["schema_version"] ?? ENRICHMENT_SCHEMA_VERSION,
        generated_at: envelope["generated_at"] ?? new Date(0).toISOString(),
        generated_at_epoch_ms: envelope["generated_at_epoch_ms"] ?? 0,
      }
    : {
        schema_version: ENRICHMENT_SCHEMA_VERSION,
        generated_at: new Date(0).toISOString(),
        generated_at_epoch_ms: 0,
      };

  const report: TruncationReport = {
    ...base,
    applied: true,
    strategy: "hard-truncate",
    preview: "",
  };

  // Measure the shape `enrichState` will actually return, then shrink the
  // preview until the whole envelope fits the budget.
  const measure = (previewText: string): EnrichedState => ({
    [ENRICHMENT_KEY]: {
      ...meta,
      truncation: { ...report, preview: previewText },
    },
  });

  let previewChars = Math.max(0, (maxTokens - estimateTokens(measure(""))) * 4);
  let preview = serialized.slice(0, previewChars);
  let stub = measure(preview);

  while (estimateTokens(stub) > maxTokens && previewChars > 0) {
    previewChars = Math.floor(previewChars / 2);
    preview = serialized.slice(0, previewChars);
    stub = measure(preview);
  }

  report.preview = preview;
  report.finalTokens = estimateTokens(stub);

  return { value: stub, report };
}

/* -------------------------------------------------------------------------- *
 * Custom calculators
 * -------------------------------------------------------------------------- */

function normalizeCalculators(
  input: CustomCalculatorInput | undefined,
): Record<string, CustomCalculator> {
  if (!input) return {};
  if (typeof input === "function") return { custom: input };
  if (Array.isArray(input)) {
    const out: Record<string, CustomCalculator> = {};
    input.forEach((fn, index) => {
      out[`custom_${index}`] = fn;
    });
    return out;
  }
  return { ...input };
}

function runCalculators(
  calculators: Record<string, CustomCalculator>,
  rawState: Record<string, unknown>,
  context: CustomCalculatorContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(calculators).sort()) {
    const calculator = calculators[name] as CustomCalculator;
    try {
      const result = calculator(rawState, context);
      out[name] = result ?? null;
    } catch (error) {
      throw new JevShieldError(
        `Custom calculator "${name}" threw while enriching state.`,
        { code: "JEVD_CALCULATOR", cause: error },
      );
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * Public API
 * -------------------------------------------------------------------------- */

/**
 * Deterministically pre-processes application state before it is sent to Jev,
 * patching Jev's inability to compute dates, item counts or aggregates.
 *
 * The original payload is preserved untouched; every derived fact is added
 * under {@link ENRICHMENT_KEY}. Given the same input and the same `now`, the
 * output is byte-identical.
 *
 * @param rawState  The state to enrich.
 * @param customCalculators  One calculator, an array of them, or a named map.
 * @param options  Reference instant and token budget.
 */
export function enrichState(
  rawState: Record<string, unknown>,
  customCalculators?: CustomCalculatorInput,
  options: EnrichStateOptions = {},
): EnrichedState {
  const now = options.now !== undefined ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new JevShieldError("`options.now` is not a valid date.", {
      code: "JEVD_ENRICHMENT_INPUT",
    });
  }

  const maxTokens = options.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
  const computeStats = options.computeStats ?? true;
  const computeDateDifferences = options.computeDateDifferences ?? true;

  const collected: Collected = { dates: {}, counts: {}, stats: {} };
  const root = isPlainObject(rawState) ? rawState : {};
  const seen = new WeakSet<object>();
  for (const [key, value] of Object.entries(root)) {
    collect(
      value,
      key,
      now.getTime(),
      { computeStats, computeDateDifferences },
      collected,
      seen,
    );
  }

  const derived: EnrichmentDerived = {
    schema_version: ENRICHMENT_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    generated_at_epoch_ms: now.getTime(),
    dates: collected.dates,
    counts: collected.counts,
    stats: collected.stats,
    date_differences: computeDateDifferences
      ? buildDateDifferences(collected.dates)
      : {},
    custom: {},
    truncation: {
      applied: false,
      strategy: "none",
      estimatedTokens: 0,
      finalTokens: 0,
      maxTokens,
    },
  };

  derived.custom = runCalculators(
    normalizeCalculators(customCalculators),
    root,
    { now, derived },
  );

  const enriched: EnrichedState = { ...root, [ENRICHMENT_KEY]: derived };
  const { value, report } = enforceTokenBudget(enriched, maxTokens);

  if (options.strictTokenBudget && report.applied) {
    throw new JevShieldError(
      `Enriched state is ${report.estimatedTokens} tokens, above the ${maxTokens} token budget, and strictTokenBudget is enabled.`,
      { code: "JEVD_TOKEN_BUDGET" },
    );
  }

  const envelope = value[ENRICHMENT_KEY];
  if (isPlainObject(envelope)) {
    envelope.truncation = report;
  }
  return value;
}
