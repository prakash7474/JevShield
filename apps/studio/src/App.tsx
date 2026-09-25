import {
  DockviewReact,
  themeAbyss,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from "dockview-react";
import { useCallback, useRef, useState, type FunctionComponent } from "react";

import { SettingsModal } from "@/components/SettingsModal";
import { Toolbar } from "@/components/Toolbar";
import { CascadeGraph } from "@/components/panels/CascadeGraph";
import { ProbabilityInspector } from "@/components/panels/ProbabilityInspector";
import { QuestionBuilder } from "@/components/panels/QuestionBuilder";
import { StateEditor } from "@/components/panels/StateEditor";
import { TrajectoryLog } from "@/components/panels/TrajectoryLog";
import { useStudioStore } from "@/store/useStudioStore";

const PANELS: Record<string, FunctionComponent<IDockviewPanelProps>> = {
  stateEditor: () => <StateEditor />,
  questionBuilder: () => <QuestionBuilder />,
  cascadeGraph: () => <CascadeGraph />,
  probabilityInspector: () => <ProbabilityInspector />,
  trajectoryLog: () => <TrajectoryLog />,
};

/**
 * Builds the four-zone workbench: left column (state over questions), centre
 * cascade simulator, right inspector, full-width trajectory log underneath.
 *
 * The log is docked *first* so it becomes the root grid node, which is what
 * makes it span the full window width instead of only the centre column.
 */
function buildDefaultLayout(api: DockviewApi): void {
  api.addPanel({
    id: "trajectoryLog",
    component: "trajectoryLog",
    title: "Trajectory Log",
    initialHeight: 240,
  });

  api.addPanel({
    id: "cascadeGraph",
    component: "cascadeGraph",
    title: "Cascade Simulator",
    position: { referencePanel: "trajectoryLog", direction: "above" },
  });

  api.addPanel({
    id: "stateEditor",
    component: "stateEditor",
    title: "State & Enrichment",
    position: { referencePanel: "cascadeGraph", direction: "left" },
    initialWidth: 520,
  });

  api.addPanel({
    id: "questionBuilder",
    component: "questionBuilder",
    title: "Question Set",
    position: { referencePanel: "stateEditor", direction: "below" },
  });

  api.addPanel({
    id: "probabilityInspector",
    component: "probabilityInspector",
    title: "Probability Inspector",
    position: { referencePanel: "cascadeGraph", direction: "right" },
    initialWidth: 460,
  });
}

export function App() {
  const setLayoutJson = useStudioStore((state) => state.setLayoutJson);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const layoutTimer = useRef<number | null>(null);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;

      // Restore the user's docked arrangement when one was persisted.
      const stored = useStudioStore.getState().layoutJson;
      let restored = false;
      if (stored) {
        try {
          api.fromJSON(JSON.parse(stored));
          restored = true;
        } catch {
          restored = false;
        }
      }
      if (!restored) buildDefaultLayout(api);

      api.onDidLayoutChange(() => {
        if (layoutTimer.current !== null) {
          window.clearTimeout(layoutTimer.current);
        }
        layoutTimer.current = window.setTimeout(() => {
          try {
            setLayoutJson(JSON.stringify(api.toJSON()));
          } catch {
            // A non-serializable layout is not worth crashing the workbench.
          }
        }, 250);
      });
    },
    [setLayoutJson],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-0 text-slate-200">
      <Toolbar onOpenSettings={() => setSettingsOpen(true)} />
      <main className="min-h-0 flex-1">
        <DockviewReact
          theme={themeAbyss}
          components={PANELS}
          onReady={onReady}
        />
      </main>
      <SettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
