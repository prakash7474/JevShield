import {
  CircleAlert,
  ChevronDown,
  ChevronUp,
  ListChecks,
  Plus,
  ShieldCheck,
  Trash,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import {
  EmptyState,
  FieldRow,
  Panel,
  PanelToolbar,
} from "@/components/ui/panel";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/ui/tabs";
import type { JevInstructions, JevQuestion } from "@jevshield/core";
import {
  QUESTION_KINDS,
  QUESTION_KIND_BLURB,
  QUESTION_KIND_LABEL,
  createQuestion,
  questionIssues,
} from "@/lib/questions";
import { cn } from "@/lib/cn";
import { useStudioStore } from "@/store/useStudioStore";
import type { QuestionKind } from "@/types";

function instructionsToText(instructions: JevQuestion["instructions"]): string {
  return typeof instructions === "string"
    ? instructions
    : JSON.stringify(instructions, null, 2);
}

/**
 * Graphical designer for the question set. Choice options and Score levels are
 * edited structurally so Jev's hard limits (255 options, 2–10 levels) can be
 * surfaced as you type rather than as a 422 at request time.
 */
export function QuestionBuilder() {
  const questions = useStudioStore((state) => state.questions);
  const guardrailsEnabled = useStudioStore((state) => state.guardrailsEnabled);
  const setGuardrailsEnabled = useStudioStore(
    (state) => state.setGuardrailsEnabled,
  );
  const addQuestion = useStudioStore((state) => state.addQuestion);
  const updateQuestion = useStudioStore((state) => state.updateQuestion);
  const removeQuestion = useStudioStore((state) => state.removeQuestion);

  const ids = useMemo(() => Object.keys(questions), [questions]);
  const [selectedId, setSelectedId] = useState<string | null>(ids[0] ?? null);

  useEffect(() => {
    if (selectedId && questions[selectedId]) return;
    setSelectedId(ids[0] ?? null);
  }, [ids, questions, selectedId]);

  const issueCount = ids.reduce(
    (total, id) => total + questionIssues(id, questions[id] as JevQuestion).length,
    0,
  );
  const selected = selectedId ? questions[selectedId] : undefined;

  return (
    <Panel>
      <PanelToolbar>
        <Badge tone="accent" className="gap-1">
          <ListChecks className="h-3 w-3" />
          Questions
        </Badge>
        <span className="text-[11px] text-slate-500">{ids.length} defined</span>
        {issueCount > 0 ? (
          <Badge tone="warn" className="gap-1">
            <TriangleAlert className="h-3 w-3" />
            {issueCount} issue{issueCount === 1 ? "" : "s"}
          </Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {QUESTION_KINDS.map((kind) => (
            <Button
              key={kind}
              size="xs"
              variant="outline"
              icon={<Plus className="h-3 w-3" />}
              onClick={() => {
                addQuestion(kind);
              }}
              title={`Add a ${QUESTION_KIND_LABEL[kind]} question`}
            >
              {QUESTION_KIND_LABEL[kind]}
            </Button>
          ))}
        </div>
      </PanelToolbar>

      {/* Security firewall toggle */}
      <div className="flex shrink-0 items-center gap-3 border-b border-edge bg-surface-1/40 px-3 py-2">
        <ShieldCheck
          className={cn(
            "h-4 w-4 shrink-0",
            guardrailsEnabled ? "text-ok" : "text-slate-600",
          )}
        />
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium text-slate-200">
            Security firewall
          </span>
          <span className="truncate text-[10px] text-slate-500">
            Injects a parallel adversarial{" "}
            <code className="text-slate-400">noul</code> question into the same
            request
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[10px] text-slate-500">
            __jevshield_adversarial_check
          </span>
          <Switch
            checked={guardrailsEnabled}
            onCheckedChange={setGuardrailsEnabled}
            aria-label="Enable the dual security gate"
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Question list */}
        <div className="flex w-44 shrink-0 flex-col overflow-y-auto border-r border-edge bg-surface-1/30">
          {ids.length === 0 ? (
            <p className="p-3 text-[11px] text-slate-500">
              No questions yet. Add one to get started.
            </p>
          ) : (
            ids.map((id) => {
              const question = questions[id] as JevQuestion;
              const issues = questionIssues(id, question);
              const blocking = issues.some((issue) => issue.level === "error");
              const active = id === selectedId;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSelectedId(id)}
                  className={cn(
                    "flex flex-col items-start gap-1 border-b border-edge/60 px-2.5 py-2 text-left transition-colors",
                    active ? "bg-accent/10" : "hover:bg-surface-2",
                  )}
                >
                  <span className="flex w-full items-center gap-1.5">
                    <span
                      className={cn(
                        "truncate font-mono text-[11px]",
                        active ? "text-accent" : "text-slate-300",
                      )}
                    >
                      {id}
                    </span>
                    {blocking ? (
                      <CircleAlert className="ml-auto h-3 w-3 shrink-0 text-danger" />
                    ) : issues.length > 0 ? (
                      <TriangleAlert className="ml-auto h-3 w-3 shrink-0 text-warn" />
                    ) : null}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    {question.type}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Selected question form */}
        <div className="min-w-0 flex-1 overflow-y-auto p-3">
          {!selected || !selectedId ? (
            <EmptyState
              icon={<ListChecks className="h-5 w-5" />}
              title="No question selected"
              hint="Add a Noul, Choice or Score question, then configure it here."
            />
          ) : (
            <QuestionForm
              id={selectedId}
              question={selected}
              onChange={(next) => updateQuestion(selectedId, next)}
              onRemove={() => removeQuestion(selectedId)}
            />
          )}
        </div>
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- *
 * Per-kind form
 * -------------------------------------------------------------------------- */

function QuestionForm({
  id,
  question,
  onChange,
  onRemove,
}: {
  id: string;
  question: JevQuestion;
  onChange: (question: JevQuestion) => void;
  onRemove: () => void;
}) {
  const renameQuestion = useStudioStore((state) => state.renameQuestion);
  const questions = useStudioStore((state) => state.questions);
  const [idDraft, setIdDraft] = useState(id);
  const [renameError, setRenameError] = useState<string | null>(null);

  useEffect(() => {
    setIdDraft(id);
    setRenameError(null);
  }, [id]);

  const issues = questionIssues(id, question);

  const commitRename = () => {
    const next = idDraft.trim();
    if (next === id) return;
    if (!next) {
      setRenameError("Question id is required.");
      setIdDraft(id);
      return;
    }
    if (questions[next]) {
      setRenameError(`"${next}" already exists.`);
      return;
    }
    if (!renameQuestion(id, next)) {
      setRenameError("Could not rename this question.");
      return;
    }
    setRenameError(null);
  };

  const changeKind = (kind: QuestionKind) => {
    if (kind === question.type) return;
    // Keep the instruction text, reset the kind-specific criteria.
    onChange({
      ...createQuestion(kind),
      instructions: instructionsToText(question.instructions),
    });
  };

  const setInstructions = (value: string) => {
    onChange({ ...question, instructions: value });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <FieldRow
            label="Question id"
            hint="Returned as the answer key. Letters, digits and underscores."
          >
            <Input
              value={idDraft}
              onChange={(event) => setIdDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitRename();
                }
                if (event.key === "Escape") setIdDraft(id);
              }}
              className="font-mono text-xs"
            />
          </FieldRow>
        </div>
        <Button
          size="sm"
          variant="danger"
          icon={<Trash className="h-3.5 w-3.5" />}
          onClick={onRemove}
          title="Delete this question"
        >
          Delete
        </Button>
      </div>

      {renameError ? (
        <p className="text-[11px] text-danger">{renameError}</p>
      ) : null}

      <div className="flex flex-col gap-1">
        <Segmented<QuestionKind>
          value={question.type}
          onChange={changeKind}
          options={QUESTION_KINDS.map((kind) => ({
            value: kind,
            label: QUESTION_KIND_LABEL[kind],
          }))}
        />
        <p className="text-[11px] leading-snug text-slate-500">
          {QUESTION_KIND_BLURB[question.type]}
        </p>
      </div>

      <FieldRow
        label="Instructions"
        hint="May be a string, or a JSON object holding the question plus the data it references."
      >
        <Textarea
          rows={3}
          value={instructionsToText(question.instructions)}
          onChange={(event) => setInstructions(event.target.value)}
          className="font-mono text-[11px]"
        />
      </FieldRow>

      {question.type === "noul" ? (
        <NoulCriteriaForm
          trueText={criteriaText(question.criteria?.true)}
          falseText={criteriaText(question.criteria?.false)}
          onChange={(side, value) => {
            const criteria = {
              ...(question.criteria ?? {}),
              [side]: value,
            };
            if (!value.trim()) delete criteria[side];
            onChange({ ...question, criteria });
          }}
        />
      ) : null}

      {question.type === "choice" ? (
        <ChoiceCriteriaForm question={question} onChange={onChange} />
      ) : null}

      {question.type === "score" ? (
        <ScoreCriteriaForm question={question} onChange={onChange} />
      ) : null}

      <IssueList issues={issues} />
    </div>
  );
}

function criteriaText(value: JevQuestion["instructions"] | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function NoulCriteriaForm({
  trueText,
  falseText,
  onChange,
}: {
  trueText: string;
  falseText: string;
  onChange: (side: "true" | "false", value: string) => void;
}) {
  return (
    <div className="grid gap-3">
      <FieldRow
        label="What “yes” means (optional)"
        hint="Describing both poles measurably improves calibration."
      >
        <Input
          value={trueText}
          onChange={(event) => onChange("true", event.target.value)}
        />
      </FieldRow>
      <FieldRow label="What “no” means (optional)">
        <Input
          value={falseText}
          onChange={(event) => onChange("false", event.target.value)}
        />
      </FieldRow>
    </div>
  );
}

function ChoiceCriteriaForm({
  question,
  onChange,
}: {
  question: Extract<JevQuestion, { type: "choice" }>;
  onChange: (question: JevQuestion) => void;
}) {
  const options = Object.keys(question.criteria ?? {});

  const setOption = (index: number, option: string, rubric: string) => {
    const labels = [...options];
    labels[index] = option;

    const criteria: Record<string, string | null> = {};
    labels.forEach((label, position) => {
      // Read the rubric from the original label so renames keep their value.
      const original = options[position] ?? "";
      criteria[label] =
        position === index
          ? rubric
          : String(question.criteria[original] ?? "");
    });
    onChange({ ...question, criteria });
  };

  const addOption = () => {
    const criteria = { ...question.criteria };
    let index = options.length + 1;
    while (criteria[`option_${index}`]) index += 1;
    criteria[`option_${index}`] = "Describe when this option applies";
    onChange({ ...question, criteria });
  };

  const removeOption = (option: string) => {
    const criteria = { ...question.criteria };
    delete criteria[option];
    onChange({ ...question, criteria });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>Options ({options.length})</Label>
        <Button
          size="xs"
          variant="outline"
          icon={<Plus className="h-3 w-3" />}
          onClick={addOption}
        >
          Add option
        </Button>
      </div>

      {options.length === 0 ? (
        <p className="text-[11px] text-danger">
          A Choice question needs at least one option.
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5">
        {options.map((option, index) => (
          <div key={`${option}-${index}`} className="flex items-center gap-1.5">
            <Input
              value={option}
              onChange={(event) =>
                setOption(index, event.target.value, String(question.criteria[option] ?? ""))
              }
              placeholder="option key"
              className="w-36 shrink-0 font-mono text-[11px]"
            />
            <Input
              value={String(question.criteria[option] ?? "")}
              onChange={(event) => setOption(index, option, event.target.value)}
              placeholder="rubric description"
              className="min-w-0 flex-1 text-[11px]"
            />
            <Button
              size="iconSm"
              variant="ghost"
              onClick={() => removeOption(option)}
              title="Remove option"
            >
              <Trash className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ScoreCriteriaForm({
  question,
  onChange,
}: {
  question: Extract<JevQuestion, { type: "score" }>;
  onChange: (question: JevQuestion) => void;
}) {
  const levels = question.criteria ?? [];

  const replace = (next: JevInstructions[]) => {
    onChange({ ...question, criteria: next });
  };

  const addLevel = () => {
    if (levels.length >= 10) return;
    replace([...levels, `Level ${levels.length}`]);
  };

  const removeLevel = (index: number) => {
    replace(levels.filter((_, position) => position !== index));
  };

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= levels.length) return;
    const next = [...levels];
    const a = next[index];
    const b = next[target];
    if (a === undefined || b === undefined) return;
    next[index] = b;
    next[target] = a;
    replace(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>
          Scale levels ({levels.length} of 2–10)
        </Label>
        <Button
          size="xs"
          variant="outline"
          icon={<Plus className="h-3 w-3" />}
          onClick={addLevel}
          disabled={levels.length >= 10}
        >
          Add level
        </Button>
      </div>

      <div className="flex flex-col gap-1.5">
        {levels.map((level, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <span className="w-5 shrink-0 text-center font-mono text-[11px] text-slate-500">
              {index}
            </span>
            <Input
              value={typeof level === "string" ? level : JSON.stringify(level)}
              onChange={(event) => {
                const next = [...levels];
                next[index] = event.target.value;
                replace(next);
              }}
              className="min-w-0 flex-1 text-[11px]"
            />
            <Button
              size="iconSm"
              variant="ghost"
              onClick={() => move(index, -1)}
              disabled={index === 0}
              title="Move level up"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="iconSm"
              variant="ghost"
              onClick={() => move(index, 1)}
              disabled={index === levels.length - 1}
              title="Move level down"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="iconSm"
              variant="ghost"
              onClick={() => removeLevel(index)}
              disabled={levels.length <= 2}
              title="Remove level"
            >
              <Trash className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function IssueList({
  issues,
}: {
  issues: ReturnType<typeof questionIssues>;
}) {
  if (issues.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-ok">
        <ShieldCheck className="h-3.5 w-3.5" />
        Valid — this question is within Jev's limits.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1">
      {issues.map((issue, index) => (
        <li
          key={index}
          className={cn(
            "flex items-start gap-1.5 text-[11px] leading-snug",
            issue.level === "error" ? "text-danger" : "text-warn",
          )}
        >
          {issue.level === "error" ? (
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          {issue.message}
        </li>
      ))}
    </ul>
  );
}
