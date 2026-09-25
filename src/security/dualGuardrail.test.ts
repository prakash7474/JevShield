import { describe, expect, it } from "vitest";

import type { JevQuestions } from "../types/index.js";
import {
  ADVERSARIAL_CHECK_KEY,
  extractSecurityVerdict,
  injectSecurityGate,
} from "./dualGuardrail.js";

const base: JevQuestions = {
  is_urgent: { type: "noul", instructions: "Does this convey urgency?" },
};

describe("injectSecurityGate", () => {
  it("adds a lowercase noul question without mutating the input", () => {
    const gate = injectSecurityGate(base);

    expect(gate.injected).toBe(true);
    expect(gate.key).toBe(ADVERSARIAL_CHECK_KEY);
    expect(Object.keys(base)).toEqual(["is_urgent"]);

    const question = gate.questions[ADVERSARIAL_CHECK_KEY];
    expect(question?.type).toBe("noul");
    if (question?.type === "noul") {
      expect(String(question.instructions)).toContain("prompt injection");
      expect(question.criteria?.["true"]).toBeDefined();
      expect(question.criteria?.["false"]).toBeDefined();
    }
  });

  it("throws when the reserved id is already taken", () => {
    const taken: JevQuestions = {
      ...base,
      [ADVERSARIAL_CHECK_KEY]: { type: "noul", instructions: "hijacked" },
    };

    expect(() => injectSecurityGate(taken)).toThrow(/already defined/);
  });

  it("can replace or skip on conflict", () => {
    const taken: JevQuestions = {
      ...base,
      [ADVERSARIAL_CHECK_KEY]: { type: "noul", instructions: "hijacked" },
    };

    const replaced = injectSecurityGate(taken, { onConflict: "replace" });
    expect(replaced.injected).toBe(true);
    expect(
      String(replaced.questions[ADVERSARIAL_CHECK_KEY]?.instructions),
    ).toContain("prompt injection");

    const skipped = injectSecurityGate(taken, { onConflict: "skip" });
    expect(skipped.injected).toBe(false);
    expect(
      String(skipped.questions[ADVERSARIAL_CHECK_KEY]?.instructions),
    ).toContain("hijacked");
  });

  it("honours a custom key and instructions", () => {
    const gate = injectSecurityGate(base, {
      key: "guard",
      instructions: "custom guard",
    });

    expect(Object.keys(gate.questions)).toEqual(["is_urgent", "guard"]);
    expect(String(gate.questions["guard"]?.instructions)).toBe("custom guard");
  });

  it("rejects an out-of-range threshold", () => {
    expect(() => injectSecurityGate(base, { threshold: 1.5 })).toThrow(
      /threshold/i,
    );
    expect(() => injectSecurityGate(base, { threshold: 0 })).toThrow(
      /threshold/i,
    );
  });
});

describe("extractSecurityVerdict", () => {
  it("returns a non-blocking verdict when the check is absent", () => {
    const verdict = extractSecurityVerdict({
      is_urgent: { type: "noul", noul: 0.9 },
    });

    expect(verdict.present).toBe(false);
    expect(verdict.injectionProbability).toBe(0);
    expect(verdict.blocked).toBe(false);
    expect(verdict.severity).toBe("none");
  });

  it("blocks when the adversarial probability crosses the threshold", () => {
    const verdict = extractSecurityVerdict(
      { [ADVERSARIAL_CHECK_KEY]: { type: "noul", noul: 0.91 } },
      { threshold: 0.5 },
    );

    expect(verdict.present).toBe(true);
    expect(verdict.blocked).toBe(true);
    expect(verdict.severity).toBe("high");
    expect(verdict.injectionProbability).toBeCloseTo(0.91, 5);
  });

  it("grades severity in bands below the block threshold", () => {
    const medium = extractSecurityVerdict(
      { [ADVERSARIAL_CHECK_KEY]: { type: "noul", noul: 0.7 } },
      { threshold: 0.99 },
    );
    expect(medium.blocked).toBe(false);
    expect(medium.severity).toBe("medium");

    const low = extractSecurityVerdict({
      [ADVERSARIAL_CHECK_KEY]: { type: "noul", noul: 0.4 },
    });
    expect(low.severity).toBe("low");
  });

  it("reads a full response envelope", () => {
    const verdict = extractSecurityVerdict({
      model: "jev-1.13.0",
      usage: { input_tokens: 10, output_tokens: 2 },
      answers: { [ADVERSARIAL_CHECK_KEY]: { type: "noul", noul: 0.2 } },
    });

    expect(verdict.present).toBe(true);
    expect(verdict.blocked).toBe(false);
    expect(verdict.severity).toBe("none");
  });

  it("treats a non-noul answer at the reserved id as absent", () => {
    const verdict = extractSecurityVerdict({
      [ADVERSARIAL_CHECK_KEY]: {
        type: "choice",
        choice: "yes",
        probabilities: { yes: 1 },
        confidence: 1,
      },
    });

    expect(verdict.present).toBe(false);
    expect(verdict.blocked).toBe(false);
  });
});
