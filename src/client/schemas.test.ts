import { describe, expect, it } from "vitest";

import type { JevQuestions } from "../types/index.js";
import { parseJevResponse, validateQuestions } from "./schemas.js";

describe("validateQuestions", () => {
  it("accepts a valid question map", () => {
    const questions: JevQuestions = {
      is_urgent: { type: "noul", instructions: "urgent?" },
      department: {
        type: "choice",
        instructions: "which team?",
        criteria: { billing: "payments", technical: null },
      },
      frustration: {
        type: "score",
        instructions: "how frustrated?",
        criteria: ["Calm", "Frustrated", "Very angry"],
      },
    };

    expect(validateQuestions(questions)).toBe(questions);
  });

  it("rejects an empty question map", () => {
    expect(() => validateQuestions({})).toThrow(/At least one question/);
  });

  it("enforces the 255-option ceiling on choices", () => {
    const criteria: Record<string, string> = {};
    for (let index = 0; index < 256; index += 1) {
      criteria[`option_${index}`] = "description";
    }

    expect(() =>
      validateQuestions({
        pick: { type: "choice", instructions: "pick one", criteria },
      }),
    ).toThrow(/at most 255/);
  });

  it("enforces the 2-10 level range on scores", () => {
    expect(() =>
      validateQuestions({
        rate: { type: "score", instructions: "rate", criteria: ["only"] },
      }),
    ).toThrow(/between 2 and 10/);

    expect(() =>
      validateQuestions({
        rate: {
          type: "score",
          instructions: "rate",
          criteria: Array.from({ length: 11 }, (_, index) => `level ${index}`),
        },
      }),
    ).toThrow(/between 2 and 10/);
  });

  it("rejects a malformed question", () => {
    expect(() =>
      validateQuestions({
        broken: { type: "choice", instructions: "no criteria" },
      } as unknown as JevQuestions),
    ).toThrow(/malformed/);
  });
});

describe("parseJevResponse", () => {
  it("parses a documented response", () => {
    const response = parseJevResponse({
      model: "jev-1.13.0",
      answers: {
        department: {
          type: "choice",
          choice: "billing",
          probabilities: { billing: 0.88, technical: 0.12 },
          confidence: 0.81,
        },
      },
      usage: { input_tokens: 318, output_tokens: 34 },
    });

    expect(response.answers["department"]?.type).toBe("choice");
    expect(response.usage.input_tokens).toBe(318);
  });

  it("defaults a missing usage block instead of failing the request", () => {
    const response = parseJevResponse({
      model: "jev-1.13.0",
      answers: { is_urgent: { type: "noul", noul: 0.5 } },
    });

    expect(response.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("rejects an unknown answer type", () => {
    expect(() =>
      parseJevResponse({
        model: "jev-1.13.0",
        answers: { summary: { type: "prose", text: "hello" } },
      }),
    ).toThrow(/answer schema/);
  });
});
