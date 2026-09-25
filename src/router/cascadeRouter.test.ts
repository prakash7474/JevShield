import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    public readonly models = { generateContent };
  },
}));

import { JevFallbackError } from "../errors.js";
import {
  CascadeRouter,
  DEFAULT_CASCADE_MODEL,
  GeminiCascadeRouter,
} from "./cascadeRouter.js";

const originalKey = process.env["GEMINI_API_KEY"];
const originalModel = process.env["GEMINI_MODEL"];

beforeEach(() => {
  generateContent.mockReset();
  delete process.env["GEMINI_API_KEY"];
  delete process.env["GEMINI_MODEL"];
});

afterEach(() => {
  if (originalKey === undefined) delete process.env["GEMINI_API_KEY"];
  else process.env["GEMINI_API_KEY"] = originalKey;
  if (originalModel === undefined) delete process.env["GEMINI_MODEL"];
  else process.env["GEMINI_MODEL"] = originalModel;
});

describe("GeminiCascadeRouter", () => {
  it("requires a Gemini API key", () => {
    expect(() => new GeminiCascadeRouter()).toThrow(
      /GEMINI_API_KEY is required for generative actions/,
    );
  });

  it("reads the key from the environment when not passed explicitly", () => {
    process.env["GEMINI_API_KEY"] = "env-key";
    expect(() => new GeminiCascadeRouter()).not.toThrow();
  });

  it("sends the documented params and returns the response text", async () => {
    generateContent.mockResolvedValue({
      text: "Here is the drafted policy.",
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 34 },
    });

    const router = new GeminiCascadeRouter("test-key");
    const result = await router.generate("Draft a refund policy.", "Be brief.");

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent).toHaveBeenCalledWith({
      model: DEFAULT_CASCADE_MODEL,
      contents: "Draft a refund policy.",
      config: { systemInstruction: "Be brief." },
    });
    expect(result.text).toBe("Here is the drafted policy.");
    expect(result.model).toBe(DEFAULT_CASCADE_MODEL);
    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 34 });
  });

  it("omits the system instruction when none is supplied", async () => {
    generateContent.mockResolvedValue({ text: "ok" });

    const router = new GeminiCascadeRouter("test-key");
    await router.generateText("plain prompt");

    expect(generateContent).toHaveBeenCalledWith({
      model: DEFAULT_CASCADE_MODEL,
      contents: "plain prompt",
    });
  });

  it("returns an empty string when the model produces no text", async () => {
    generateContent.mockResolvedValue({ text: undefined });

    const router = new GeminiCascadeRouter("test-key");
    await expect(router.generateText("p")).resolves.toBe("");
  });

  it("honours model, sampling and timeout options", async () => {
    generateContent.mockResolvedValue({ text: "x" });

    const router = new GeminiCascadeRouter("test-key", {
      model: "gemini-custom",
      temperature: 0.4,
      maxOutputTokens: 64,
      timeoutMs: 5_000,
    });
    await expect(router.generateText("p", "sys")).resolves.toBe("x");

    expect(generateContent).toHaveBeenCalledWith({
      model: "gemini-custom",
      contents: "p",
      config: {
        systemInstruction: "sys",
        temperature: 0.4,
        maxOutputTokens: 64,
        httpOptions: { timeout: 5_000 },
      },
    });
  });

  it("falls back to the model named by GEMINI_MODEL", async () => {
    process.env["GEMINI_MODEL"] = "gemini-from-env";
    generateContent.mockResolvedValue({ text: "x" });

    const router = new GeminiCascadeRouter("test-key");
    expect(router.model).toBe("gemini-from-env");
    await router.generateText("p");
    expect(generateContent).toHaveBeenCalledWith({
      model: "gemini-from-env",
      contents: "p",
    });
  });

  it("applies a default system instruction", async () => {
    generateContent.mockResolvedValue({ text: "x" });

    const router = new GeminiCascadeRouter("test-key", {
      defaultSystemInstruction: "You are helpful.",
    });
    await router.generateText("p");

    expect(generateContent).toHaveBeenCalledWith({
      model: DEFAULT_CASCADE_MODEL,
      contents: "p",
      config: { systemInstruction: "You are helpful." },
    });
  });

  it("wraps provider failures in a typed error", async () => {
    generateContent.mockRejectedValue(new Error("quota exceeded"));

    const router = new GeminiCascadeRouter("test-key");
    await expect(router.generateText("p")).rejects.toBeInstanceOf(
      JevFallbackError,
    );
    await expect(router.generateText("p")).rejects.toThrow(/quota exceeded/);
  });

  it("rejects an empty prompt without calling the provider", async () => {
    const router = new GeminiCascadeRouter("test-key");

    await expect(router.generateText("   ")).rejects.toThrow(
      /non-empty prompt/,
    );
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("exposes the underlying SDK client and the CascadeRouter alias", () => {
    const router = new GeminiCascadeRouter("test-key");
    expect(router.client).toBeDefined();
    expect(CascadeRouter).toBe(GeminiCascadeRouter);
  });
});
