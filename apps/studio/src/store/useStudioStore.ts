import type { JevQuestion, JevQuestions } from "@jevshield/core";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  createOversizedQuestions,
  ADVERSARIAL_STATE_TEXT,
  OVERSIZED_STATE_TEXT,
  SAMPLE_QUESTIONS,
  SAMPLE_STATE_TEXT,
} from "../engine/samples";
import type {
  Credentials,
  QuestionKind,
  RunRecord,
  StudioMode,
  Thresholds,
} from "../types";
import { createQuestion, uniqueQuestionId } from "../lib/questions";

export const DEFAULT_THRESHOLDS: Thresholds = { autoAct: 0.85, cascade: 0.7 };

export const DEFAULT_MODEL = "jev-latest";

/** Keeps the persisted trajectory log bounded. */
export const MAX_RUNS = 100;

const EMPTY_CREDENTIALS: Credentials = { typesafeApiKey: "", geminiApiKey: "" };

export interface StudioState {
  /* Design time ---------------------------------------------------------- */
  stateText: string;
  questions: JevQuestions;
  guardrailsEnabled: boolean;
  thresholds: Thresholds;
  model: string;

  /* Runtime -------------------------------------------------------------- */
  runs: RunRecord[];
  selectedRunId: string | null;
  running: boolean;
  lastError: string | null;

  /* Credentials ---------------------------------------------------------- */
  credentials: Credentials;
  forceDemo: boolean;

  /* Layout --------------------------------------------------------------- */
  layoutJson: string | null;

  /* Actions -------------------------------------------------------------- */
  setStateText(stateText: string): void;
  setQuestions(questions: JevQuestions): void;
  addQuestion(kind: QuestionKind): void;
  updateQuestion(id: string, question: JevQuestion): void;
  renameQuestion(from: string, to: string): boolean;
  removeQuestion(id: string): void;
  resetQuestions(questions: JevQuestions): void;

  setGuardrailsEnabled(enabled: boolean): void;
  setThresholds(thresholds: Partial<Thresholds>): void;
  setModel(model: string): void;

  loadSample(): void;
  loadInjectionSample(): void;
  loadOversizedSample(): void;

  setCredentials(credentials: Partial<Credentials>): void;
  clearCredentials(): void;
  setForceDemo(forceDemo: boolean): void;

  appendRun(run: RunRecord): void;
  selectRun(id: string | null): void;
  clearRuns(): void;
  setRunning(running: boolean): void;
  setLastError(error: string | null): void;

  loadSnapshot(run: RunRecord): void;
  setLayoutJson(layoutJson: string | null): void;
}

/** Live requires a TypeSafe key; Gemini is optional and degrades gracefully. */
export function resolveMode(
  credentials: Credentials,
  forceDemo: boolean,
): StudioMode {
  if (forceDemo) return "demo";
  return credentials.typesafeApiKey.trim().length > 0 ? "live" : "demo";
}

export const useStudioStore = create<StudioState>()(
  persist(
    (set, get) => ({
      stateText: SAMPLE_STATE_TEXT,
      questions: SAMPLE_QUESTIONS,
      guardrailsEnabled: true,
      thresholds: DEFAULT_THRESHOLDS,
      model: DEFAULT_MODEL,

      runs: [],
      selectedRunId: null,
      running: false,
      lastError: null,

      credentials: EMPTY_CREDENTIALS,
      forceDemo: true,

      layoutJson: null,

      setStateText: (stateText) => set({ stateText }),

      setQuestions: (questions) => set({ questions }),

      addQuestion: (kind) => {
        const questions = get().questions;
        const id = uniqueQuestionId(questions, `${kind}_question`);
        set({ questions: { ...questions, [id]: createQuestion(kind) } });
      },

      updateQuestion: (id, question) =>
        set((state) => ({ questions: { ...state.questions, [id]: question } })),

      renameQuestion: (from, to) => {
        if (from === to) return true;
        const questions = get().questions;
        const question = questions[from];
        if (!question) return false;
        if (questions[to]) return false;

        const next: JevQuestions = {};
        for (const [id, value] of Object.entries(questions)) {
          next[id === from ? to : id] = value;
        }
        set({ questions: next });
        return true;
      },

      removeQuestion: (id) =>
        set((state) => {
          const next = { ...state.questions };
          delete next[id];
          return { questions: next };
        }),

      resetQuestions: (questions) => set({ questions }),

      setGuardrailsEnabled: (guardrailsEnabled) => set({ guardrailsEnabled }),

      setThresholds: (thresholds) =>
        set((state) => ({
          thresholds: { ...state.thresholds, ...thresholds },
        })),

      setModel: (model) => set({ model }),

      loadSample: () =>
        set({
          stateText: SAMPLE_STATE_TEXT,
          questions: SAMPLE_QUESTIONS,
          guardrailsEnabled: true,
          lastError: null,
        }),

      loadInjectionSample: () =>
        set({
          stateText: ADVERSARIAL_STATE_TEXT,
          guardrailsEnabled: true,
          lastError: null,
        }),

      loadOversizedSample: () =>
        set({
          stateText: OVERSIZED_STATE_TEXT,
          questions: createOversizedQuestions(300),
          guardrailsEnabled: false,
          lastError: null,
        }),

      setCredentials: (credentials) =>
        set((state) => ({
          credentials: { ...state.credentials, ...credentials },
        })),

      clearCredentials: () =>
        set({ credentials: EMPTY_CREDENTIALS, forceDemo: true }),

      setForceDemo: (forceDemo) => set({ forceDemo }),

      appendRun: (run) =>
        set((state) => ({
          runs: [run, ...state.runs].slice(0, MAX_RUNS),
          selectedRunId: run.id,
        })),

      selectRun: (selectedRunId) => set({ selectedRunId }),

      clearRuns: () => set({ runs: [], selectedRunId: null }),

      setRunning: (running) => set({ running }),

      setLastError: (lastError) => set({ lastError }),

      loadSnapshot: (run) =>
        set({
          stateText: run.snapshot.stateText,
          questions: run.snapshot.questions,
          guardrailsEnabled: run.snapshot.guardrailsEnabled,
          thresholds: run.snapshot.thresholds,
          model: run.snapshot.model,
          lastError: null,
        }),

      setLayoutJson: (layoutJson) => set({ layoutJson }),
    }),
    {
      name: "jevshield-studio",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Runtime flags like `running` are deliberately not persisted.
      partialize: (state) => ({
        stateText: state.stateText,
        questions: state.questions,
        guardrailsEnabled: state.guardrailsEnabled,
        thresholds: state.thresholds,
        model: state.model,
        credentials: state.credentials,
        forceDemo: state.forceDemo,
        runs: state.runs,
        selectedRunId: state.selectedRunId,
        layoutJson: state.layoutJson,
      }),
    },
  ),
);

/* -------------------------------------------------------------------------- *
 * Derived selectors
 * -------------------------------------------------------------------------- */

export function useMode(): StudioMode {
  return useStudioStore((state) => resolveMode(state.credentials, state.forceDemo));
}

export function useActiveRun(): RunRecord | null {
  return useStudioStore(
    (state) =>
      state.runs.find((run) => run.id === state.selectedRunId) ??
      state.runs[0] ??
      null,
  );
}
