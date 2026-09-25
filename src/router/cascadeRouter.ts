import {
  GoogleGenAI,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from "@google/genai";

import {
  JevFallbackError,
  JevShieldConfigError,
  JevShieldError,
  JevValidationError,
} from "../errors.js";

/** Fast, low-latency Flash model used for downstream generation. */
export const DEFAULT_CASCADE_MODEL = "gemini-2.5-flash";

export interface CascadeRouterOptions {
  /** Overrides `process.env.GEMINI_MODEL` and {@link DEFAULT_CASCADE_MODEL}. */
  model?: string;
  /** Applied when `generate` is called without an explicit system instruction. */
  defaultSystemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Per-request timeout in ms, forwarded as `httpOptions.timeout`. */
  timeoutMs?: number;
  /** Cancellation signal forwarded to the SDK. */
  signal?: AbortSignal;
}

export interface CascadeGeneration {
  text: string;
  model: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

function assertPrompt(prompt: string): string {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new JevValidationError(
      "GeminiCascadeRouter requires a non-empty prompt.",
    );
  }
  return prompt;
}

function readUsage(
  metadata: GenerateContentResponse["usageMetadata"],
): CascadeGeneration["usage"] {
  if (!metadata) return undefined;
  const usage: NonNullable<CascadeGeneration["usage"]> = {};
  if (typeof metadata.promptTokenCount === "number") {
    usage.input_tokens = metadata.promptTokenCount;
  }
  if (typeof metadata.candidatesTokenCount === "number") {
    usage.output_tokens = metadata.candidatesTokenCount;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * The generative half of the JevShield cascade.
 *
 * Jev resolves the bounded, typed decision; when a decision cannot be expressed
 * as a probability (prose, code drafting, explanations) this router hands the
 * work to Gemini Flash over `@google/genai`.
 *
 * ```ts
 * const router = new GeminiCascadeRouter(process.env.GEMINI_API_KEY);
 * const text = await router.generateText("Draft a refund policy.", "Be concise.");
 * ```
 */
export class GeminiCascadeRouter {
  readonly #ai: GoogleGenAI;
  readonly #model: string;
  readonly #options: CascadeRouterOptions;

  constructor(apiKey?: string, options: CascadeRouterOptions = {}) {
    const key = apiKey || process.env["GEMINI_API_KEY"];
    if (!key) {
      throw new JevShieldConfigError(
        "GEMINI_API_KEY is required for generative actions.",
      );
    }

    this.#options = options;
    this.#model =
      options.model ?? process.env["GEMINI_MODEL"] ?? DEFAULT_CASCADE_MODEL;
    this.#ai = new GoogleGenAI({ apiKey: key });
  }

  /** The resolved model id, e.g. `"gemini-2.5-flash"`. */
  get model(): string {
    return this.#model;
  }

  /** Escape hatch for advanced SDK features not surfaced here. */
  get client(): GoogleGenAI {
    return this.#ai;
  }

  /**
   * Generates text for `prompt`, optionally steered by `systemInstruction`.
   *
   * @returns The completion, or `""` when the model produced no text (a
   * blocked or truncated response) so callers can branch without a null check.
   */
  async generateText(
    prompt: string,
    systemInstruction?: string,
  ): Promise<string> {
    const generation = await this.generate(prompt, systemInstruction);
    return generation.text;
  }

  /** Like {@link generateText}, but also reports the model and token usage. */
  async generate(
    prompt: string,
    systemInstruction?: string,
  ): Promise<CascadeGeneration> {
    const contents = assertPrompt(prompt);

    const config: GenerateContentConfig = {};
    const instruction =
      systemInstruction ?? this.#options.defaultSystemInstruction;
    if (instruction) config.systemInstruction = instruction;
    if (this.#options.temperature !== undefined) {
      config.temperature = this.#options.temperature;
    }
    if (this.#options.maxOutputTokens !== undefined) {
      config.maxOutputTokens = this.#options.maxOutputTokens;
    }
    if (this.#options.timeoutMs !== undefined) {
      config.httpOptions = { timeout: this.#options.timeoutMs };
    }
    if (this.#options.signal !== undefined) {
      config.abortSignal = this.#options.signal;
    }

    const params: GenerateContentParameters = {
      model: this.#model,
      contents,
    };
    if (Object.keys(config).length > 0) {
      params.config = config;
    }

    try {
      const response = await this.#ai.models.generateContent(params);
      const usage = readUsage(response.usageMetadata);
      return {
        text: response.text || "",
        model: this.#model,
        ...(usage ? { usage } : {}),
      };
    } catch (error) {
      if (error instanceof JevShieldError) throw error;
      throw new JevFallbackError(
        `Gemini text generation failed: ${error instanceof Error ? error.message : String(error)}`,
        { provider: "gemini", cause: error },
      );
    }
  }
}

/** Alias matching the module name. */
export { GeminiCascadeRouter as CascadeRouter };
