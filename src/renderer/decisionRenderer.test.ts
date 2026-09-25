import { describe, expect, it } from "vitest";

import type { JevAnswers } from "../types/index.js";
import {
  normalizeAnswer,
  overallConfidence,
  renderDecisionReport,
  renderProse,
  toDecisions,
} from "./decisionRenderer.js";

const answers: JevAnswers = {
  is_urgent: { type: "noul", noul: 0.95 },
  department: {
    type: "choice",
    choice: "billing",
    probabilities: { billing: 0.88, technical: 0.12 },
    confidence: 0.81,
  },
  frustration: {
    type: "score",
    score: 1.05,
    legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
    probabilities: { "0": 0, "1": 0.95, "2": 0.05 },
    confidence: 0.92,
  },
};

describe("normalizeAnswer", () => {
  it("normalizes a noul answer into a symmetric probability", () => {
    const decision = normalizeAnswer("is_urgent", answers["is_urgent"] as never);

    expect(decision.type).toBe("noul");
    expect(decision.value).toBe(0.95);
    expect(decision.label).toBe("yes");
    expect(decision.confidence).toBeCloseTo(0.95, 6);
    expect(decision.probabilities).toEqual({ yes: 0.95, no: 0.050000000000000044 });
  });

  it("picks the winning option and its probability", () => {
    const decision = normalizeAnswer("department", answers["department"] as never);

    expect(decision.type).toBe("choice");
    expect(decision.value).toBe("billing");
    expect(decision.probability).toBe(0.88);
    expect(decision.confidence).toBe(0.81);
  });

  it("maps a score onto its nearest rubric level", () => {
    const decision = normalizeAnswer("frustration", answers["frustration"] as never);

    expect(decision.type).toBe("score");
    expect(decision.value).toBe(1.05);
    expect(decision.label).toBe("Frustrated");
    expect(decision.probability).toBe(0.95);
  });

  it("clamps out-of-range probabilities", () => {
    const decision = normalizeAnswer("x", { type: "noul", noul: 1.4 } as never);
    expect(decision.value).toBe(1);
    expect(decision.confidence).toBe(1);
  });
});

describe("rendering", () => {
  it("sorts decisions by id and joins questions", () => {
    const decisions = toDecisions(answers, {
      is_urgent: { type: "noul", instructions: "urgent?" },
    });

    expect(decisions.map((decision) => decision.id)).toEqual([
      "department",
      "frustration",
      "is_urgent",
    ]);
    expect(decisions[2]?.question).toBeDefined();
  });

  it("produces a deterministic, human-readable report", () => {
    const report = renderDecisionReport(toDecisions(answers));

    expect(report).toContain("- is_urgent → yes");
    expect(report).toContain('- department → "billing"');
    expect(report).toContain('- frustration → 1.05 of 2 ("Frustrated"');
    expect(report.split("\n")).toHaveLength(3);
  });

  it("renders prose deterministically and reports the weakest decision", () => {
    const decisions = toDecisions(answers);
    const prose = renderProse(decisions);

    expect(prose).toBe(renderProse(toDecisions(answers)));
    expect(prose).toContain('"is_urgent" resolved to yes with probability 0.950.');
    expect(prose).toContain('"department" resolved to "billing"');
    expect(overallConfidence(decisions)).toBeCloseTo(0.81, 6);
  });

  it("treats an empty decision set as fully confident", () => {
    expect(overallConfidence([])).toBe(1);
    expect(renderProse([])).toBe("");
  });
});
