import {
  CircleAlert,
  CircleCheck,
  GitFork,
  RotateCcw,
  ScrollText,
  Trash,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, Panel, PanelToolbar } from "@/components/ui/panel";
import { cn } from "@/lib/cn";
import {
  formatClock,
  formatMs,
  formatPercent,
  formatTokens,
  formatUsd,
} from "@/lib/format";
import { useRunPipeline } from "@/hooks/useRunPipeline";
import { useStudioStore } from "@/store/useStudioStore";
import type { RunRecord } from "@/types";

const ACTION_LABEL: Record<string, string> = {
  "auto-act": "auto-act",
  "human-escalation": "human",
  "generative-cascade": "cascade",
  blocked: "blocked",
};

const ACTION_TONE: Record<string, "ok" | "warn" | "violet" | "danger"> = {
  "auto-act": "ok",
  "human-escalation": "warn",
  "generative-cascade": "violet",
  blocked: "danger",
};

function columns(): Array<{ key: string; label: string; align?: "right" }> {
  return [
    { key: "seq", label: "#" },
    { key: "time", label: "Time" },
    { key: "mode", label: "Mode" },
    { key: "status", label: "Status" },
    { key: "action", label: "Route" },
    { key: "total", label: "Total", align: "right" },
    { key: "jev", label: "Jev", align: "right" },
    { key: "gemini", label: "Gemini", align: "right" },
    { key: "tokens", label: "Tokens", align: "right" },
    { key: "cost", label: "Cost", align: "right" },
    { key: "conf", label: "Conf.", align: "right" },
  ];
}

/**
 * Append-only execution history. Selecting a row drives the inspector and the
 * cascade graph; Replay re-runs the snapshot, Fork loads it into the editors
 * without executing.
 */
export function TrajectoryLog() {
  const runs = useStudioStore((state) => state.runs);
  const selectedRunId = useStudioStore((state) => state.selectedRunId);
  const selectRun = useStudioStore((state) => state.selectRun);
  const clearRuns = useStudioStore((state) => state.clearRuns);
  const loadSnapshot = useStudioStore((state) => state.loadSnapshot);
  const setLayoutJson = useStudioStore((state) => state.setLayoutJson);
  const { run: execute, running } = useRunPipeline();

  const selected =
    runs.find((item) => item.id === selectedRunId) ?? runs[0] ?? null;

  const replay = async (record: RunRecord) => {
    loadSnapshot(record);
    await execute();
  };

  const fork = (record: RunRecord) => {
    loadSnapshot(record);
  };

  const header = columns();

  return (
    <Panel>
      <PanelToolbar>
        <Badge tone="accent" className="gap-1">
          <ScrollText className="h-3 w-3" />
          Trajectory
        </Badge>
        <span className="text-[11px] text-slate-500">
          {runs.length} run{runs.length === 1 ? "" : "s"} this session
        </span>
        {selected?.error ? (
          <Badge tone="danger" className="gap-1">
            <CircleAlert className="h-3 w-3" />
            Last error
          </Badge>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="xs"
            variant="outline"
            icon={<RotateCcw className="h-3 w-3" />}
            disabled={!selected || running}
            onClick={() => {
              if (selected) void replay(selected);
            }}
          >
            Replay
          </Button>
          <Button
            size="xs"
            variant="outline"
            icon={<GitFork className="h-3 w-3" />}
            disabled={!selected}
            onClick={() => {
              if (selected) fork(selected);
            }}
            title="Load this snapshot into the editors without running it"
          >
            Fork
          </Button>
          <Button
            size="xs"
            variant="ghost"
            icon={<Trash className="h-3 w-3" />}
            disabled={runs.length === 0}
            onClick={clearRuns}
          >
            Clear
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setLayoutJson(null)}
            title="Reset the docked panel layout on next launch"
          >
            Reset layout
          </Button>
        </div>
      </PanelToolbar>

      {runs.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="h-5 w-5" />}
          title="No runs recorded"
          hint="Every execution is appended here with its latency split, token usage and estimated cost. Click a row to re-inspect or fork it."
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-surface-1">
              <tr className="border-b border-edge">
                {header.map((column) => (
                  <th
                    key={column.key}
                    className={cn(
                      "whitespace-nowrap px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500",
                      column.align === "right" && "text-right",
                    )}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.map((record, index) => {
                const active = record.id === selected?.id;
                return (
                  <tr
                    key={record.id}
                    onClick={() => selectRun(record.id)}
                    className={cn(
                      "cursor-pointer border-b border-edge/50 transition-colors",
                      active ? "bg-accent/10" : "hover:bg-surface-2/60",
                      record.status === "error" && "bg-danger/5",
                    )}
                  >
                    <td className="px-2.5 py-1.5 font-mono text-[11px] text-slate-500">
                      {runs.length - index}
                    </td>
                    <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-[11px] text-slate-300">
                      {formatClock(record.startedAt)}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <Badge tone={record.mode === "live" ? "accent" : "neutral"}>
                        {record.mode}
                      </Badge>
                    </td>
                    <td className="px-2.5 py-1.5">
                      <span className="flex items-center gap-1.5">
                        {record.status === "ok" ? (
                          <CircleCheck className="h-3.5 w-3.5 text-ok" />
                        ) : record.status === "blocked" ? (
                          <TriangleAlert className="h-3.5 w-3.5 text-danger" />
                        ) : (
                          <CircleAlert className="h-3.5 w-3.5 text-danger" />
                        )}
                        <span className="text-[11px] text-slate-300">
                          {record.status}
                        </span>
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5">
                      <Badge tone={ACTION_TONE[record.action] ?? "neutral"}>
                        {ACTION_LABEL[record.action] ?? record.action}
                      </Badge>
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono text-[11px] text-slate-300">
                      {formatMs(record.latency.totalMs)}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono text-[11px] text-slate-400">
                      {formatMs(record.latency.jevLatencyMs)}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono text-[11px] text-slate-400">
                      {record.latency.geminiLatencyMs > 0
                        ? formatMs(record.latency.geminiLatencyMs)
                        : "—"}
                    </td>
                    <td className="whitespace-nowrap px-2.5 py-1.5 text-right font-mono text-[11px] text-slate-400">
                      {formatTokens(
                        record.usage.jevInputTokens +
                          record.usage.jevOutputTokens +
                          record.usage.geminiInputTokens +
                          record.usage.geminiOutputTokens,
                      )}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono text-[11px] text-slate-400">
                      {formatUsd(record.usage.estimatedCostUsd)}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-mono text-[11px] text-slate-300">
                      {formatPercent(record.confidence)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-edge bg-surface-1/40 px-3 py-2 text-[11px]">
          <span className="font-mono text-slate-400">
            {selected.snapshot.stateText.length.toLocaleString()} char snapshot
          </span>
          <span className="text-slate-500">
            {Object.keys(selected.snapshot.questions).length} questions
          </span>
          <span className="text-slate-500">
            security{" "}
            <span
              className={
                selected.security.blocked ? "text-danger" : "text-ok"
              }
            >
              {selected.security.present
                ? formatPercent(selected.security.injectionProbability)
                : "disabled"}
            </span>
          </span>
          {selected.error ? (
            <span className="truncate text-danger">{selected.error}</span>
          ) : (
            <span className="truncate text-slate-500">
              {selected.prose || "(no prose)"}
            </span>
          )}
        </div>
      ) : null}
    </Panel>
  );
}
