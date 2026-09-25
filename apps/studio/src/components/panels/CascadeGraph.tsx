import {
  ArrowRight,
  Ban,
  Braces,
  Calculator,
  CircleCheck,
  Gauge,
  Scissors,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Badge, stageTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, Panel, PanelToolbar } from "@/components/ui/panel";
import { formatMs, formatPercent } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useActiveRun, useMode, useStudioStore } from "@/store/useStudioStore";
import { useRunPipeline } from "@/hooks/useRunPipeline";
import type { CascadeStageId, StageResult, StageStatus } from "@/types";

const STAGE_ICON: Record<CascadeStageId, ReactNode> = {
  input: <Braces className="h-4 w-4" />,
  enricher: <Calculator className="h-4 w-4" />,
  security: <ShieldCheck className="h-4 w-4" />,
  chunker: <Scissors className="h-4 w-4" />,
  confidence: <Gauge className="h-4 w-4" />,
  action: <Sparkles className="h-4 w-4" />,
};

const ACTION_LABEL: Record<string, string> = {
  "auto-act": "Auto-act",
  "human-escalation": "Human escalation",
  "generative-cascade": "Generative cascade",
  blocked: "Blocked",
};

const STATUS_RING: Record<StageStatus, string> = {
  passed: "border-ok/50",
  escalated: "border-violet/60",
  warn: "border-warn/50",
  blocked: "border-danger/60",
  bypassed: "border-edge",
  pending: "border-info/50",
};

/**
 * Visual execution canvas for the request lifecycle. Every node is clickable
 * and shows exactly what that stage produced for the selected run.
 */
export function CascadeGraph() {
  const run = useActiveRun();
  const mode = useMode();
  const { run: execute, running } = useRunPipeline();
  const [selectedStage, setSelectedStage] = useState<CascadeStageId | null>(null);

  useEffect(() => {
    if (!run) {
      setSelectedStage(null);
      return;
    }
    setSelectedStage((current) =>
      current && run.stages.some((stage) => stage.id === current)
        ? current
        : (run.stages[run.stages.length - 1]?.id ?? null),
    );
  }, [run]);

  const active = useMemo(
    () => run?.stages.find((stage) => stage.id === selectedStage) ?? null,
    [run, selectedStage],
  );

  return (
    <Panel>
      <PanelToolbar>
        <Badge tone="accent" className="gap-1">
          <Workflow className="h-3 w-3" />
          Cascade
        </Badge>

        {run ? (
          <>
            <Badge tone={run.status === "blocked" ? "danger" : run.status === "error" ? "danger" : "ok"}>
              {ACTION_LABEL[run.action] ?? run.action}
            </Badge>
            <span className="font-mono text-[11px] text-slate-500">
              {formatMs(run.latency.totalMs)} total
            </span>
          </>
        ) : (
          <span className="text-[11px] text-slate-500">No run yet</span>
        )}

        <span className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[10px] text-slate-600">
            {mode === "live" ? "live API" : "simulated"}
          </span>
          <Button
            size="sm"
            variant="default"
            loading={running}
            icon={<Sparkles className="h-3.5 w-3.5" />}
            onClick={() => void execute()}
          >
            Run pipeline
          </Button>
        </span>
      </PanelToolbar>

      {!run ? (
        <EmptyState
          icon={<Workflow className="h-6 w-6" />}
          title="No execution yet"
          hint="Press Run pipeline to trace a request through the enricher, security gate, chunker, confidence evaluator and cascade action."
          action={
            <Button
              size="sm"
              variant="default"
              loading={running}
              onClick={() => void execute()}
            >
              Run pipeline
            </Button>
          }
        />
      ) : (
        <>
          <div className="shrink-0 overflow-x-auto border-b border-edge bg-surface-1/20 p-3">
            <div className="flex min-w-max items-stretch gap-1">
              {run.stages.map((stage, index) => (
                <div key={`${stage.id}-${index}`} className="flex items-stretch">
                  <StageNode
                    stage={stage}
                    active={stage.id === selectedStage}
                    onSelect={() => setSelectedStage(stage.id)}
                  />
                  {index < run.stages.length - 1 ? (
                    <div className="flex w-7 items-center justify-center">
                      <ArrowRight className="h-3.5 w-3.5 text-slate-600" />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          {active ? <StageDetail stage={active} runAction={run.action} /> : null}
        </>
      )}
    </Panel>
  );
}

function StageNode({
  stage,
  active,
  onSelect,
}: {
  stage: StageResult;
  active: boolean;
  onSelect: () => void;
}) {
  const blocked = stage.status === "blocked";

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-44 flex-col gap-2 rounded-md border bg-surface-1 p-2.5 text-left transition-colors",
        STATUS_RING[stage.status],
        active ? "bg-surface-2" : "hover:bg-surface-2/60",
      )}
    >
      <span className="flex items-center gap-2">
        <span
          className={cn(
            "shrink-0",
            blocked ? "text-danger" : "text-slate-400",
          )}
        >
          {blocked ? <Ban className="h-4 w-4" /> : STAGE_ICON[stage.id]}
        </span>
        <span className="truncate text-[11px] font-semibold text-slate-200">
          {stage.label}
        </span>
        {stage.status === "passed" ? (
          <CircleCheck className="ml-auto h-3.5 w-3.5 shrink-0 text-ok" />
        ) : null}
      </span>

      <span className="line-clamp-3 text-[10px] leading-snug text-slate-500">
        {stage.summary}
      </span>

      <span className="mt-auto flex items-center gap-2">
        <Badge tone={stageTone(stage.status)}>{stage.status}</Badge>
        {stage.durationMs > 0 ? (
          <span className="font-mono text-[10px] text-slate-500">
            {formatMs(stage.durationMs)}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function StageDetail({
  stage,
  runAction,
}: {
  stage: StageResult;
  runAction: string;
}) {
  const run = useActiveRun();
  const thresholds = useStudioStore((state) => state.thresholds);

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-slate-400">{STAGE_ICON[stage.id]}</span>
        <h3 className="text-xs font-semibold text-slate-200">{stage.label}</h3>
        <Badge tone={stageTone(stage.status)}>{stage.status}</Badge>
        {stage.durationMs > 0 ? (
          <span className="font-mono text-[11px] text-slate-500">
            {formatMs(stage.durationMs)}
          </span>
        ) : null}
        <span className="ml-auto text-[11px] text-slate-500">
          {stage.summary}
        </span>
      </header>

      <ul className="flex flex-col gap-1.5">
        {stage.details.map((detail, index) => (
          <li
            key={index}
            className="flex items-start gap-2 rounded border border-edge bg-surface-1 px-2.5 py-1.5 text-[11px] leading-snug text-slate-300"
          >
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-600" />
            <span className="min-w-0 break-words font-mono">{detail}</span>
          </li>
        ))}
      </ul>

      {stage.id === "confidence" && run ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Metric label="Lowest confidence" value={formatPercent(run.confidence)} />
          <Metric label="Cascade below" value={formatPercent(thresholds.cascade, 0)} />
          <Metric label="Auto-act at" value={formatPercent(thresholds.autoAct, 0)} />
          <Metric label="Resolved route" value={ACTION_LABEL[runAction] ?? runAction} />
        </div>
      ) : null}

      {stage.id === "action" && run ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Metric label="Prose source" value={run.proseSource} />
          <Metric label="Jev latency" value={formatMs(run.latency.jevLatencyMs)} />
          <Metric label="Gemini latency" value={formatMs(run.latency.geminiLatencyMs)} />
          <Metric label="Run mode" value={run.mode} />
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded border border-edge bg-surface-1 px-2.5 py-1.5">
      <span className="text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <span className="font-mono text-[11px] text-slate-200">{value}</span>
    </div>
  );
}
