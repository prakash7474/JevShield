import { useCallback } from "react";

import { runPipeline } from "@/engine/engineClient";
import { resolveMode, useStudioStore } from "@/store/useStudioStore";

/**
 * Executes one pipeline run.
 *
 * Reads the store imperatively (`getState`) so a run always sees the latest
 * editor contents and credentials rather than a stale render closure.
 */
export function useRunPipeline(): {
  run: () => Promise<void>;
  running: boolean;
} {
  const running = useStudioStore((state) => state.running);

  const run = useCallback(async () => {
    const state = useStudioStore.getState();
    if (state.running) return;

    state.setRunning(true);
    state.setLastError(null);

    try {
      const record = await runPipeline({
        stateText: state.stateText,
        questions: state.questions,
        guardrailsEnabled: state.guardrailsEnabled,
        thresholds: state.thresholds,
        model: state.model,
        credentials: state.credentials,
        mode: resolveMode(state.credentials, state.forceDemo),
        runIndex: state.runs.length,
      });

      state.appendRun(record);
      if (record.error) state.setLastError(record.error);
    } catch (error) {
      state.setLastError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      useStudioStore.getState().setRunning(false);
    }
  }, []);

  return { run, running };
}
