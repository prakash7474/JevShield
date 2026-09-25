import Editor from "@monaco-editor/react";
import {
  Braces,
  Calculator,
  CircleAlert,
  CircleCheck,
  ListOrdered,
  TriangleAlert,
  Wand2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, Panel, PanelToolbar } from "@/components/ui/panel";
import { Segmented } from "@/components/ui/tabs";
import { computeEnrichmentPreview } from "@/engine/enrichmentPreview";
import { MONACO_THEME } from "@/lib/monacoSetup";
import { formatNumber, formatTokens } from "@/lib/format";
import { useStudioStore } from "@/store/useStudioStore";

type PreviewTab = "dates" | "counts" | "stats" | "deltas";

/**
 * Live editor for the raw state payload. The preview runs the real JevShield
 * enricher so you can see exactly which dates, counts and aggregates Jev will
 * receive before spending a request.
 */
export function StateEditor() {
  const stateText = useStudioStore((state) => state.stateText);
  const setStateText = useStudioStore((state) => state.setStateText);
  const [tab, setTab] = useState<PreviewTab>("dates");
  const [debounced, setDebounced] = useState(stateText);

  // Debounce so the enricher does not run on every keystroke.
  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(stateText), 250);
    return () => window.clearTimeout(handle);
  }, [stateText]);

  const preview = useMemo(
    () => computeEnrichmentPreview(debounced),
    [debounced],
  );

  const format = () => {
    try {
      setStateText(JSON.stringify(JSON.parse(stateText), null, 2));
    } catch {
      // Leave malformed JSON alone; the validity badge already reports it.
    }
  };

  const derivedTotal =
    preview.dates.length +
    preview.counts.length +
    preview.stats.length +
    preview.dateDifferences.length;

  return (
    <Panel>
      <PanelToolbar>
        <Badge tone="accent" className="gap-1">
          <Braces className="h-3 w-3" />
          State
        </Badge>

        {preview.error ? (
          <Badge tone="danger" className="gap-1">
            <CircleAlert className="h-3 w-3" />
            Invalid JSON
          </Badge>
        ) : (
          <Badge tone="ok" className="gap-1">
            <CircleCheck className="h-3 w-3" />
            Valid JSON
          </Badge>
        )}

        {preview.applied ? (
          <Badge tone="warn" className="gap-1">
            <TriangleAlert className="h-3 w-3" />
            Truncated: {preview.strategy}
          </Badge>
        ) : null}

        <span className="ml-auto flex items-center gap-3 text-[11px] text-slate-500">
          <span className="font-mono">
            ~{formatTokens(preview.estimatedTokens)} tok
          </span>
          <Button
            size="xs"
            variant="ghost"
            icon={<Wand2 className="h-3 w-3" />}
            onClick={format}
          >
            Format
          </Button>
        </span>
      </PanelToolbar>

      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          language="json"
          theme={MONACO_THEME}
          value={stateText}
          onChange={(value) => setStateText(value ?? "")}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            lineNumbersMinChars: 3,
            scrollBeyondLastLine: false,
            tabSize: 2,
            renderLineHighlight: "line",
            padding: { top: 10, bottom: 10 },
            fontFamily:
              '"JetBrains Mono", "SFMono-Regular", ui-monospace, monospace',
            scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
          }}
        />
      </div>

      {/* ---- Enricher preview ------------------------------------------- */}
      <div className="flex h-[46%] min-h-[180px] shrink-0 flex-col border-t border-edge">
        <PanelToolbar className="bg-transparent">
          <Badge tone="info" className="gap-1">
            <Calculator className="h-3 w-3" />
            Enricher preview
          </Badge>
          <span className="text-[11px] text-slate-500">
            {derivedTotal} derived fact{derivedTotal === 1 ? "" : "s"}
          </span>
          <div className="ml-auto">
            <Segmented<PreviewTab>
              value={tab}
              onChange={setTab}
              options={[
                { value: "dates", label: `Dates ${preview.dates.length}` },
                { value: "counts", label: `Counts ${preview.counts.length}` },
                { value: "stats", label: `Stats ${preview.stats.length}` },
                {
                  value: "deltas",
                  label: `Deltas ${preview.dateDifferences.length}`,
                },
              ]}
            />
          </div>
        </PanelToolbar>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {!preview.ok ? (
            <EmptyState
              icon={<CircleAlert className="h-5 w-5" />}
              title="Cannot enrich this state"
              hint={preview.error ?? "Fix the payload to see derived facts."}
            />
          ) : !preview.isObjectState ? (
            <EmptyState
              icon={<Braces className="h-5 w-5" />}
              title="Primitive state — enrichment skipped"
              hint="Only structured object payloads can be enriched with dates, counts and aggregates."
            />
          ) : derivedTotal === 0 ? (
            <EmptyState
              icon={<Calculator className="h-5 w-5" />}
              title="Nothing to derive"
              hint="Add ISO date strings, arrays or numeric arrays to see the enricher work."
            />
          ) : (
            <PreviewGrid
              tab={tab}
              preview={preview}
            />
          )}
        </div>
      </div>
    </Panel>
  );
}

function PreviewGrid({
  tab,
  preview,
}: {
  tab: PreviewTab;
  preview: ReturnType<typeof computeEnrichmentPreview>;
}) {
  if (tab === "dates") {
    return (
      <div className="grid gap-2">
        {preview.dates.map((entry) => (
          <div
            key={entry.path}
            className="flex items-center justify-between gap-3 rounded border border-edge bg-surface-1 px-2.5 py-1.5"
          >
            <span className="truncate font-mono text-[11px] text-accent">
              {entry.path}
            </span>
            <span className="flex shrink-0 items-center gap-3 text-[11px] text-slate-400">
              <span className="text-slate-600">{entry.iso}</span>
              <span className="font-mono text-slate-200">
                {entry.elapsedDays} d {entry.direction}
              </span>
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (tab === "counts") {
    return (
      <div className="grid gap-2">
        {preview.counts.map((entry) => (
          <div
            key={entry.path}
            className="flex items-center justify-between gap-3 rounded border border-edge bg-surface-1 px-2.5 py-1.5"
          >
            <span className="truncate font-mono text-[11px] text-info">
              {entry.path}
            </span>
            <span className="font-mono text-[11px] text-slate-200">
              {entry.count} item{entry.count === 1 ? "" : "s"}
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (tab === "stats") {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        {preview.stats.map((entry) => (
          <div
            key={entry.path}
            className="flex flex-col gap-1.5 rounded border border-edge bg-surface-1 p-2"
          >
            <span className="truncate font-mono text-[11px] text-violet">
              {entry.path}
            </span>
            <div className="grid grid-cols-3 gap-1 text-[10px] text-slate-500">
              <span>
                sum{" "}
                <span className="font-mono text-slate-200">{entry.sum}</span>
              </span>
              <span>
                mean{" "}
                <span className="font-mono text-slate-200">
                  {formatNumber(entry.mean, 2)}
                </span>
              </span>
              <span>
                median{" "}
                <span className="font-mono text-slate-200">
                  {formatNumber(entry.median, 2)}
                </span>
              </span>
              <span>
                min <span className="font-mono text-slate-200">{entry.min}</span>
              </span>
              <span>
                max <span className="font-mono text-slate-200">{entry.max}</span>
              </span>
              <span>
                n <span className="font-mono text-slate-200">{entry.count}</span>
              </span>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {preview.dateDifferences.map((entry) => (
        <div
          key={entry.pair}
          className="flex items-center gap-2 rounded border border-edge bg-surface-1 px-2.5 py-1.5"
        >
          <ListOrdered className="h-3 w-3 shrink-0 text-slate-500" />
          <span className="truncate font-mono text-[11px] text-slate-400">
            {entry.pair}
          </span>
          <span className="ml-auto font-mono text-[11px] text-slate-200">
            {entry.days} d
          </span>
        </div>
      ))}
    </div>
  );
}
