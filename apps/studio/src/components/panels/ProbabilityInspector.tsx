import type { JevDecision } from "@jevshield/core";
import { ChartColumn, Gauge, SlidersHorizontal } from "lucide-react";
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel, PanelToolbar, StatTile } from "@/components/ui/panel";
import { Slider } from "@/components/ui/slider";
import { confidenceBand } from "@/engine/engineClient";
import { formatMs, formatPercent, formatProbability } from "@/lib/format";
import { useActiveRun, useStudioStore } from "@/store/useStudioStore";

const MAX_BARS = 12;

interface ChartEntry {
  /** Original probability-map key; used as the React list key. */
  key: string;
  name: string;
  value: number;
  winner: boolean;
}

/** Builds chart rows for one decision, capped but never dropping the winner. */
function chartEntries(decision: JevDecision): ChartEntry[] {
  const entries = Object.entries(decision.probabilities).map(([key, value]) => {
    let name = key;
    if (decision.type === "score") {
      const legend =
        decision.answer.type === "score" ? decision.answer.legend : {};
      name = `${key} · ${legend[key] ?? "level"}`;
    }
    return {
      key,
      name,
      value,
      winner: decision.type === "score" ? key === String(Math.round(Number(decision.value))) : key === String(decision.value),
    };
  });

  if (decision.type === "score") {
    entries.sort((a, b) => Number(a.key) - Number(b.key));
  } else {
    entries.sort((a, b) => b.value - a.value);
  }

  if (entries.length <= MAX_BARS) return entries;

  const winner = entries.find((entry) => entry.winner);
  const top = entries.slice(0, MAX_BARS);
  if (winner && !top.includes(winner)) top[top.length - 1] = winner;
  return top;
}

/**
 * Probability and confidence inspector. Every distribution Jev returned is
 * plotted with its uniform baseline, and the threshold sliders let you re-route
 * the run without re-querying the model.
 */
export function ProbabilityInspector() {
  const run = useActiveRun();
  const thresholds = useStudioStore((state) => state.thresholds);
  const setThresholds = useStudioStore((state) => state.setThresholds);

  const order = useMemo(
    () => (run ? run.decisions.map((decision) => decision.id) : []),
    [run],
  );

  const cascade = thresholds.cascade;
  const autoAct = thresholds.autoAct;

  return (
    <Panel>
      <PanelToolbar>
        <Badge tone="accent" className="gap-1">
          <Gauge className="h-3 w-3" />
          Inspector
        </Badge>
        {run ? (
          <>
            <Badge
              tone={
                confidenceBand(run.confidence, thresholds) === "auto-act"
                  ? "ok"
                  : confidenceBand(run.confidence, thresholds) ===
                      "generative-cascade"
                    ? "violet"
                    : "warn"
              }
            >
              {formatPercent(run.confidence)} lowest
            </Badge>
            <span className="font-mono text-[11px] text-slate-500">
              {formatMs(run.latency.jevLatencyMs)} jev
            </span>
          </>
        ) : null}
      </PanelToolbar>

      {/* Threshold controls */}
      <div className="flex shrink-0 flex-col gap-3 border-b border-edge bg-surface-1/30 p-3">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-3.5 w-3.5 text-slate-500" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Routing thresholds
          </span>
          <span className="ml-auto font-mono text-[10px] text-slate-500">
            cascade {formatPercent(cascade, 0)} · auto-act{" "}
            {formatPercent(autoAct, 0)}
          </span>
        </div>

        <ThresholdBand
          cascade={cascade}
          autoAct={autoAct}
          confidences={run ? run.decisions.map((d) => d.confidence) : []}
        />

        <div className="grid gap-2.5">
          <div className="flex items-center gap-3">
            <span className="w-40 shrink-0 text-[11px] text-violet">
              Generative cascade below
            </span>
            <Slider
              min={0}
              max={0.95}
              step={0.01}
              value={[cascade]}
              onValueChange={([value]) => {
                if (value === undefined) return;
                setThresholds({ cascade: Math.min(value, autoAct - 0.05) });
              }}
              aria-label="Generative cascade threshold"
            />
            <span className="w-10 shrink-0 text-right font-mono text-[11px] text-slate-300">
              {formatPercent(cascade, 0)}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="w-40 shrink-0 text-[11px] text-ok">
              Auto-act at or above
            </span>
            <Slider
              min={0.05}
              max={1}
              step={0.01}
              value={[autoAct]}
              onValueChange={([value]) => {
                if (value === undefined) return;
                setThresholds({ autoAct: Math.max(value, cascade + 0.05) });
              }}
              aria-label="Auto-act threshold"
            />
            <span className="w-10 shrink-0 text-right font-mono text-[11px] text-slate-300">
              {formatPercent(autoAct, 0)}
            </span>
          </div>
        </div>
      </div>

      {/* Distributions */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!run || run.decisions.length === 0 ? (
          <EmptyState
            icon={<ChartColumn className="h-5 w-5" />}
            title="No probabilities to inspect"
            hint="Run the pipeline to see the calibrated distribution behind every Choice, Score and Noul answer."
          />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatTile
                label="Lowest confidence"
                value={formatPercent(run.confidence)}
                tone={
                  confidenceBand(run.confidence, thresholds) === "auto-act"
                    ? "ok"
                    : confidenceBand(run.confidence, thresholds) ===
                        "generative-cascade"
                      ? "warn"
                      : "neutral"
                }
              />
              <StatTile label="Questions" value={String(run.decisions.length)} />
              <StatTile
                label="Jev latency"
                value={formatMs(run.latency.jevLatencyMs)}
              />
              <StatTile
                label="Prose source"
                value={run.proseSource}
                tone={run.proseSource === "gemini" ? "accent" : "neutral"}
              />
            </div>

            {order.map((id) => {
              const decision = run.decisions.find((item) => item.id === id);
              if (!decision) return null;
              return (
                <DistributionCard
                  key={id}
                  decision={decision}
                  thresholds={thresholds}
                />
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}

/** Three-zone band with one marker per decision confidence. */
function ThresholdBand({
  cascade,
  autoAct,
  confidences,
}: {
  cascade: number;
  autoAct: number;
  confidences: number[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="relative h-5 overflow-hidden rounded border border-edge bg-surface-1">
        <div
          className="absolute inset-y-0 left-0 bg-violet/25"
          style={{ width: `${cascade * 100}%` }}
        />
        <div
          className="absolute inset-y-0 bg-warn/20"
          style={{
            left: `${cascade * 100}%`,
            width: `${Math.max(0, autoAct - cascade) * 100}%`,
          }}
        />
        <div
          className="absolute inset-y-0 bg-ok/20"
          style={{ left: `${autoAct * 100}%`, right: 0 }}
        />
        <div
          className="absolute inset-y-0 w-px bg-violet"
          style={{ left: `${cascade * 100}%` }}
        />
        <div
          className="absolute inset-y-0 w-px bg-ok"
          style={{ left: `${autoAct * 100}%` }}
        />
        {confidences.map((confidence, index) => (
          <div
            key={index}
            className="absolute top-0 h-full w-0.5 -translate-x-1/2 bg-slate-200/80"
            style={{ left: `${Math.min(100, Math.max(0, confidence * 100))}%` }}
            title={`confidence ${formatPercent(confidence)}`}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-slate-600">
        <span className="text-violet">0%</span>
        <span className="text-warn">human escalation</span>
        <span className="text-ok">auto-act</span>
        <span>100%</span>
      </div>
    </div>
  );
}

function DistributionCard({
  decision,
  thresholds,
}: {
  decision: JevDecision;
  thresholds: { autoAct: number; cascade: number };
}) {
  const entries = chartEntries(decision);
  const total = Object.keys(decision.probabilities).length;
  const height = Math.max(110, entries.length * 22 + 28);
  const uniform = 1 / Math.max(1, total);
  const band = confidenceBand(decision.confidence, thresholds);

  return (
    <section className="flex flex-col gap-2 rounded border border-edge bg-surface-1/60 p-2.5">
      <header className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] text-slate-200">
          {decision.id}
        </span>
        <Badge tone="info">{decision.type}</Badge>
        <Badge
          tone={band === "auto-act" ? "ok" : band === "generative-cascade" ? "violet" : "warn"}
        >
          {formatPercent(decision.confidence)}
        </Badge>
        <span className="ml-auto truncate font-mono text-[10px] text-slate-500">
          {decision.type === "noul"
            ? `p(yes)=${formatProbability(Number(decision.value))}`
            : decision.type === "choice"
              ? `"${decision.value}" @ ${formatProbability(decision.probability ?? 0)}`
              : `${decision.value} · "${decision.label}"`}
        </span>
      </header>

      {total > entries.length ? (
        <p className="text-[10px] text-slate-600">
          Showing the top {entries.length} of {total} options, always including
          the winner.
        </p>
      ) : null}

      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={entries}
            layout="vertical"
            margin={{ top: 2, right: 34, bottom: 2, left: 2 }}
            barCategoryGap={3}
          >
            <XAxis type="number" domain={[0, 1]} hide />
            <YAxis
              type="category"
              dataKey="name"
              width={132}
              tick={{ fill: "#94a3b8", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{ fill: "#1d243080" }}
              contentStyle={{
                background: "#10141c",
                border: "1px solid #232b38",
                borderRadius: 6,
                fontSize: 11,
                color: "#e2e8f0",
              }}
              labelStyle={{ color: "#94a3b8" }}
              formatter={(value: unknown) =>
                [formatProbability(Number(value)), "probability"] as [
                  string,
                  string,
                ]
              }
            />
            <ReferenceLine x={uniform} stroke="#475569" strokeDasharray="3 3" />
            <Bar dataKey="value" radius={[0, 2, 2, 0]} isAnimationActive={false}>
              {entries.map((entry) => (
                <Cell
                  key={entry.key}
                  fill={entry.winner ? "#2dd4bf" : "#334155"}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <p className="text-[10px] text-slate-600">
        Dashed line marks the uniform baseline (1/{total}); bars above it carry
        real signal.
      </p>
    </section>
  );
}
