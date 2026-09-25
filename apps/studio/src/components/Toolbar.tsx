import {
  AlertTriangle,
  CircleAlert,
  FlaskConical,
  Play,
  Settings,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRunPipeline } from "@/hooks/useRunPipeline";
import { cn } from "@/lib/cn";
import { useMode, useStudioStore } from "@/store/useStudioStore";

export function Toolbar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const mode = useMode();
  const model = useStudioStore((state) => state.model);
  const lastError = useStudioStore((state) => state.lastError);
  const setLastError = useStudioStore((state) => state.setLastError);
  const loadSample = useStudioStore((state) => state.loadSample);
  const loadInjectionSample = useStudioStore((state) => state.loadInjectionSample);
  const loadOversizedSample = useStudioStore((state) => state.loadOversizedSample);
  const { run, running } = useRunPipeline();

  // Command/Ctrl+Enter runs the pipeline from anywhere in the workbench.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void run();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [run]);

  return (
    <header className="flex shrink-0 flex-col border-b border-edge bg-surface-1">
      <div className="flex h-11 items-center gap-3 px-3">
        <span className="flex items-center gap-2">
          <span
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded",
              mode === "live"
                ? "bg-accent/15 text-accent"
                : "bg-surface-3 text-slate-400",
            )}
          >
            {mode === "live" ? (
              <ShieldCheck className="h-3.5 w-3.5" />
            ) : (
              <FlaskConical className="h-3.5 w-3.5" />
            )}
          </span>
          <span className="text-sm font-semibold tracking-tight text-slate-100">
            JevShield <span className="text-slate-500">Studio</span>
          </span>
        </span>

        <Badge tone={mode === "live" ? "accent" : "neutral"}>
          {mode === "live" ? "live api" : "demo mode"}
        </Badge>
        <span className="hidden font-mono text-[10px] text-slate-600 sm:inline">
          {model}
        </span>

        <span className="ml-auto flex items-center gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            icon={<Play className="h-3 w-3" />}
            onClick={loadSample}
            title="Load the clean sample payload"
          >
            Sample
          </Button>
          <Button
            size="xs"
            variant="ghost"
            icon={<ShieldAlert className="h-3 w-3" />}
            onClick={loadInjectionSample}
            title="Load a payload containing a prompt-injection attempt"
          >
            Injection
          </Button>
          <Button
            size="xs"
            variant="ghost"
            icon={<AlertTriangle className="h-3 w-3" />}
            onClick={loadOversizedSample}
            title="Load a 300-option Choice question to exercise the tree chunker"
          >
            Oversized
          </Button>

          <Button
            size="sm"
            variant="default"
            loading={running}
            icon={<Play className="h-3.5 w-3.5" />}
            onClick={() => void run()}
            title="Run the pipeline (Cmd/Ctrl+Enter)"
          >
            Run
          </Button>

          <Button
            size="icon"
            variant="ghost"
            onClick={onOpenSettings}
            title="Environment & credentials"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </span>
      </div>

      {lastError ? (
        <div className="flex items-center gap-2 border-t border-danger/30 bg-danger/10 px-3 py-1.5">
          <CircleAlert className="h-3.5 w-3.5 shrink-0 text-danger" />
          <span className="min-w-0 flex-1 truncate text-[11px] text-danger">
            {lastError}
          </span>
          <button
            type="button"
            onClick={() => setLastError(null)}
            className="rounded p-0.5 text-danger/70 transition-colors hover:bg-danger/20 hover:text-danger"
            title="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
    </header>
  );
}
