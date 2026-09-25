import { ADVERSARIAL_CHECK_KEY } from "@jevshield/core";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL,
  DEFAULT_THRESHOLDS,
} from "@/store/useStudioStore";
import type { RunPipelineInput } from "@/types";
import { mergeChunkedChoice, planChunks } from "./chunker";
import { injectionHeuristic, simulateJevResponse } from "./demoData";
import { confidenceBand, parseStateText, RunInputError, runPipeline } from "./engineClient";
import {
  ADVERSARIAL_STATE_TEXT,
  createOversizedQuestions,
  SAMPLE_QUESTIONS,
  SAMPLE_STATE_TEXT,
} from "./samples";

function demoInput(overrides: Partial<RunPipelineInput> = {}): RunPipelineInput {
  return {
    stateText: SAMPLE_STATE_TEXT,
    questions: SAMPLE_QUESTIONS,
    guardrailsEnabled: true,
    thresholds: DEFAULT_THRESHOLDS,
    model: DEFAULT_MODEL,
    credentials: { typesafeApiKey: "", geminiApiKey: "" },
    mode: "demo",
    runIndex: 0,
    ...overrides,
  };
}

describe("parseStateText", () => {
  it("rejects empty and malformed payloads with a friendly error", () => {
    expect(() => parseStateText("   ")).toThrow(RunInputError);
    expect(() => parseStateText("{ not json")).toThrow(/not valid JSON/);
  });

  it("classifies object, array and primitive states", () => {
    expect(parseStateText('{"a":1}').isObject).toBe(true);
    expect(parseStateText("[1,2]").isObject).toBe(false);
    expect(parseStateText('"hello"').isObject).toBe(false);
  });
});

describe("runPipeline (demo mode)", () => {
  it("runs all six stages in order", async () => {
    const record = await runPipeline(demoInput());

    expect(record.stages.map((stage) => stage.id)).toEqual([
      "input",
      "enricher",
      "security",
      "chunker",
      "confidence",
      "action",
    ]);
    expect(record.mode).toBe("demo");
    expect(record.status).toBe("ok");
  });

  it("is deterministic for the same state and run index", async () => {
    const first = await runPipeline(demoInput());
    const second = await runPipeline(demoInput());

    expect(first.answers).toEqual(second.answers);
    expect(first.confidence).toBe(second.confidence);
    expect(first.prose).toBe(second.prose);
  });

  it("enriches the state and reports derived facts", async () => {
    const record = await runPipeline(demoInput());
    const enricher = record.stages.find((stage) => stage.id === "enricher");

    expect(enricher?.status).toBe("passed");
    expect(enricher?.summary).toMatch(/Derived \d+ date/);
  });

  it("keeps the adversarial answer out of the decisions", async () => {
    const record = await runPipeline(demoInput());

    expect(record.security.present).toBe(true);
    expect(record.answers[ADVERSARIAL_CHECK_KEY]).toBeDefined();
    expect(record.decisions.map((decision) => decision.id)).not.toContain(
      ADVERSARIAL_CHECK_KEY,
    );
    expect(record.decisions.map((decision) => decision.id).sort()).toEqual(
      Object.keys(SAMPLE_QUESTIONS).sort(),
    );
  });

  it("blocks an adversarial state when the firewall is enabled", async () => {
    const record = await runPipeline(
      demoInput({ stateText: ADVERSARIAL_STATE_TEXT }),
    );

    expect(record.security.blocked).toBe(true);
    expect(record.status).toBe("blocked");
    expect(record.action).toBe("blocked");
    expect(record.prose).toBe("");
    expect(
      record.stages.find((stage) => stage.id === "security")?.status,
    ).toBe("blocked");
  });

  it("passes the same adversarial state when the firewall is disabled", async () => {
    const record = await runPipeline(
      demoInput({ stateText: ADVERSARIAL_STATE_TEXT, guardrailsEnabled: false }),
    );

    expect(record.security.present).toBe(false);
    expect(record.security.blocked).toBe(false);
    expect(record.status).toBe("ok");
    expect(
      record.stages.find((stage) => stage.id === "security")?.status,
    ).toBe("bypassed");
  });

  it("always accounts for latency, tokens and cost", async () => {
    const record = await runPipeline(demoInput());

    expect(record.latency.jevLatencyMs).toBeGreaterThan(0);
    expect(record.latency.totalMs).toBeGreaterThan(0);
    expect(record.usage.jevInputTokens).toBeGreaterThan(0);
    expect(record.usage.jevOutputTokens).toBeGreaterThan(0);
    expect(record.usage.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("generates prose and records its source", async () => {
    const record = await runPipeline(demoInput());

    expect(record.prose.length).toBeGreaterThan(0);
    expect(["template", "gemini"]).toContain(record.proseSource);
  });

  it("flags the chunker when a Choice question exceeds 255 options", async () => {
    const record = await runPipeline(
      demoInput({
        questions: createOversizedQuestions(300),
        guardrailsEnabled: false,
      }),
    );

    const chunker = record.stages.find((stage) => stage.id === "chunker");
    expect(chunker?.status).toBe("warn");
    expect(chunker?.summary).toContain("2 chunk request(s)");
  });

  it("refuses live mode without a TypeSafe key", async () => {
    const record = await runPipeline(demoInput({ mode: "live" }));

    expect(record.status).toBe("error");
    expect(record.error).toMatch(/TYPESAFE_API_KEY/);
    expect(record.stages.find((stage) => stage.id === "action")?.status).toBe(
      "blocked",
    );
  });
});

describe("confidenceBand", () => {
  const thresholds = { cascade: 0.7, autoAct: 0.85 };

  it("routes by threshold band", () => {
    expect(confidenceBand(0.95, thresholds)).toBe("auto-act");
    expect(confidenceBand(0.85, thresholds)).toBe("auto-act");
    expect(confidenceBand(0.8, thresholds)).toBe("human-escalation");
    expect(confidenceBand(0.7, thresholds)).toBe("human-escalation");
    expect(confidenceBand(0.69, thresholds)).toBe("generative-cascade");
    expect(confidenceBand(0.1, thresholds)).toBe("generative-cascade");
  });
});

describe("tree chunker", () => {
  it("splits an oversized Choice into 255-option chunks", () => {
    const questions = createOversizedQuestions(300);
    const plan = planChunks(questions);

    expect(plan.required).toBe(true);
    expect(plan.totalChunks).toBe(2);
    expect(plan.groups[0]?.totalOptions).toBe(300);
    expect(plan.groups[0]?.chunks[0]?.options).toHaveLength(255);
    expect(plan.groups[0]?.chunks[1]?.options).toHaveLength(45);
  });

  it("leaves questions within the ceiling alone", () => {
    const plan = planChunks(SAMPLE_QUESTIONS);
    expect(plan.required).toBe(false);
    expect(plan.totalChunks).toBe(0);
  });

  it("merges chunk distributions into a valid answer", () => {
    const merged = mergeChunkedChoice([
      {
        options: ["a", "b"],
        answer: {
          type: "choice",
          choice: "a",
          probabilities: { a: 0.9, b: 0.1 },
          confidence: 0.9,
        },
      },
      {
        options: ["c", "d"],
        answer: {
          type: "choice",
          choice: "c",
          probabilities: { c: 0.6, d: 0.4 },
          confidence: 0.7,
        },
      },
    ]);

    const sum = Object.values(merged.probabilities).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 3);
    expect(merged.probabilities["a"]).toBeCloseTo(0.45, 3);
    expect(merged.choice).toBe("a");
    expect(merged.confidence).toBeGreaterThan(0);
    expect(merged.confidence).toBeLessThanOrEqual(1);
  });

  it("returns the single chunk unchanged", () => {
    const answer = {
      type: "choice" as const,
      choice: "a",
      probabilities: { a: 1 },
      confidence: 1,
    };
    expect(
      mergeChunkedChoice([{ options: ["a"], answer }]),
    ).toBe(answer);
  });
});

describe("demo simulator", () => {
  it("scores injection markers far above a clean payload", () => {
    expect(injectionHeuristic(SAMPLE_STATE_TEXT)).toBeLessThan(0.5);
    expect(injectionHeuristic(ADVERSARIAL_STATE_TEXT)).toBeGreaterThanOrEqual(
      0.5,
    );
  });

  it("produces Jev-shaped answers for every question", () => {
    const response = simulateJevResponse(SAMPLE_QUESTIONS, SAMPLE_STATE_TEXT, 42);
    const ids = Object.keys(response.answers).sort();

    expect(ids).toEqual(Object.keys(SAMPLE_QUESTIONS).sort());
    expect(response.model).toContain("demo");
    expect(response.usage.input_tokens).toBeGreaterThan(0);

    for (const answer of Object.values(response.answers)) {
      if (answer.type === "choice") {
        const sum = Object.values(answer.probabilities).reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(1, 2);
      }
      if (answer.type === "score") {
        expect(Object.keys(answer.legend).length).toBe(
          Object.keys(answer.probabilities).length,
        );
      }
    }
  });
});
