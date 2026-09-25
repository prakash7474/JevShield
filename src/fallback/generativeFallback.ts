import axios from "axios";

import { JevFallbackError, JevShieldConfigError } from "../errors.js";
import { stableStringify } from "../enricher/stateEnricher.js";
import { GeminiCascadeRouter } from "../router/cascadeRouter.js";
import type {
  FallbackProvider,
  FallbackRequest,
  FallbackResult,
  GenerativeFallback,
  JevFallbackConfig,
  JevInstructions,
} from "../types/index.js";

/** The Anthropic SDK stays optional; Gemini is a first-class dependency. */
const ANTHROPIC_SPECIFIER = "@anthropic-ai/sdk";

export const DEFAULT_FALLBACK_MODELS: Record<FallbackProvider, string> = {
  gemini: "gemini-2.5-flash",
  anthropic: "claude-sonnet-4-5",
  custom: "gpt-4o-mini",
};

const DEFAULT_SYSTEM_INSTRUCTION =
  "You are the generative escalation layer of JevShield, a wrapper around TypeSafe AI's Jev decision model. " +
  "Jev could not resolve a question with sufficient confidence, so answer it in clear, concise prose. " +
  "Ground every claim in the supplied state and never invent facts that are not present.";

/* -------------------------------------------------------------------------- *
 * Prompt construction
 * -------------------------------------------------------------------------- */

function renderInstructions(instructions: JevInstructions | undefined): string {
  if (instructions === undefined) return "(none)";
  return typeof instructions === "string"
    ? instructions
    : stableStringify(instructions);
}

function renderState(state: FallbackRequest["state"]): string {
  return typeof state === "string" ? state : stableStringify(state);
}

/** Builds the prose prompt used by every fallback provider. */
export function buildFallbackPrompt(request: FallbackRequest): string {
  const { question, questionId, reason, confidence } = request;
  const lines: string[] = [
    `Escalation reason: ${reason}${confidence === undefined ? "" : ` (Jev confidence ${confidence.toFixed(3)})`}.`,
    "",
    `Question id: ${questionId}`,
    `Question type: ${question.type}`,
    `Question: ${renderInstructions(question.instructions)}`,
  ];

  if (question.type === "noul") {
    lines.push(
      `Answer with a clear yes or no, then justify it in one or two sentences.`,
    );
    if (question.criteria?.true !== undefined) {
      lines.push(`"Yes" means: ${renderInstructions(question.criteria.true)}`);
    }
    if (question.criteria?.false !== undefined) {
      lines.push(`"No" means: ${renderInstructions(question.criteria.false)}`);
    }
  }

  if (question.type === "choice") {
    const options = Object.entries(question.criteria ?? {}).map(
      ([option, rubric]) =>
        `- ${option}${rubric === null || rubric === undefined ? "" : `: ${renderInstructions(rubric)}`}`,
    );
    lines.push("Choose exactly one of these options and state it first:", ...options);
  }

  if (question.type === "score") {
    const levels = (question.criteria ?? []).map(
      (level, index) => `- ${index}: ${renderInstructions(level)}`,
    );
    lines.push("Rate the state on this rubric and state the level first:", ...levels);
  }

  lines.push(
    "",
    "State:",
    renderState(request.state),
    "",
    "Answer directly. Do not restate the state.",
  );

  return lines.join("\n");
}

/* -------------------------------------------------------------------------- *
 * Optional SDK loading
 * -------------------------------------------------------------------------- */

async function loadOptionalModule(
  specifier: string,
): Promise<Record<string, unknown>> {
  try {
    const module: unknown = await import(specifier);
    return (module ?? {}) as Record<string, unknown>;
  } catch (error) {
    throw new JevShieldConfigError(
      `Fallback provider requires the optional dependency "${specifier}". Install it with \`npm install ${specifier}\`.`,
      error,
    );
  }
}

interface AnthropicClientLike {
  messages: {
    create(params: Record<string, unknown>): Promise<{
      content: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>;
  };
}

/* -------------------------------------------------------------------------- *
 * Providers
 * -------------------------------------------------------------------------- */

/**
 * Gemini escalation path, delegated to the shared {@link GeminiCascadeRouter}
 * so the SDK has exactly one place that talks to `@google/genai`.
 */
class GeminiFallback implements GenerativeFallback {
  public readonly provider = "gemini";
  readonly #router: GeminiCascadeRouter;
  readonly #systemInstruction: string;

  constructor(config: JevFallbackConfig, apiKey: string) {
    this.#systemInstruction =
      config.systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION;
    this.#router = new GeminiCascadeRouter(apiKey, {
      ...(config.model === undefined ? {} : { model: config.model }),
      temperature: config.temperature ?? 0.2,
      maxOutputTokens: config.maxOutputTokens ?? 1_024,
      ...(config.timeoutMs === undefined
        ? {}
        : { timeoutMs: config.timeoutMs }),
    });
  }

  async generate(request: FallbackRequest): Promise<FallbackResult> {
    const generation = await this.#router.generate(
      buildFallbackPrompt(request),
      this.#systemInstruction,
    );
    if (!generation.text) {
      throw new JevFallbackError("Gemini returned an empty completion.", {
        provider: this.provider,
      });
    }
    return {
      text: generation.text,
      provider: this.provider,
      model: generation.model,
      ...(generation.usage ? { usage: generation.usage } : {}),
    };
  }
}

class AnthropicFallback implements GenerativeFallback {
  public readonly provider = "anthropic";
  readonly #apiKey: string;
  readonly #model: string;
  readonly #systemInstruction: string;
  readonly #temperature: number;
  readonly #maxOutputTokens: number;

  constructor(config: JevFallbackConfig, apiKey: string) {
    this.#apiKey = apiKey;
    this.#model =
      config.model ??
      process.env["ANTHROPIC_MODEL"] ??
      DEFAULT_FALLBACK_MODELS.anthropic;
    this.#systemInstruction = config.systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION;
    this.#temperature = config.temperature ?? 0.2;
    this.#maxOutputTokens = config.maxOutputTokens ?? 1_024;
  }

  async generate(request: FallbackRequest): Promise<FallbackResult> {
    const module = await loadOptionalModule(ANTHROPIC_SPECIFIER);
    const ctor = (module["Anthropic"] ?? module["default"]) as
      | (new (options: { apiKey: string }) => AnthropicClientLike)
      | undefined;
    if (!ctor) {
      throw new JevFallbackError(
        `"${ANTHROPIC_SPECIFIER}" did not export a default client constructor.`,
        { provider: this.provider },
      );
    }

    const client = new ctor({ apiKey: this.#apiKey });
    const message = await client.messages.create({
      model: this.#model,
      max_tokens: this.#maxOutputTokens,
      temperature: this.#temperature,
      system: this.#systemInstruction,
      messages: [{ role: "user", content: buildFallbackPrompt(request) }],
    });

    const text = message.content
      .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
      .filter((part) => part.length > 0)
      .join("\n");
    if (!text) {
      throw new JevFallbackError("Anthropic returned an empty completion.", {
        provider: this.provider,
      });
    }

    const usage = message.usage
      ? {
          ...(message.usage.input_tokens === undefined
            ? {}
            : { input_tokens: message.usage.input_tokens }),
          ...(message.usage.output_tokens === undefined
            ? {}
            : { output_tokens: message.usage.output_tokens }),
        }
      : undefined;

    return {
      text,
      provider: this.provider,
      model: this.#model,
      ...(usage ? { usage } : {}),
    };
  }
}

class CustomEndpointFallback implements GenerativeFallback {
  public readonly provider = "custom";
  readonly #endpoint: string;
  readonly #apiKey: string | undefined;
  readonly #model: string;
  readonly #systemInstruction: string;
  readonly #temperature: number;
  readonly #maxOutputTokens: number;
  readonly #timeoutMs: number;

  constructor(config: JevFallbackConfig, endpoint: string) {
    this.#endpoint = endpoint;
    this.#apiKey = config.apiKey;
    this.#model = config.model ?? DEFAULT_FALLBACK_MODELS.custom;
    this.#systemInstruction = config.systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION;
    this.#temperature = config.temperature ?? 0.2;
    this.#maxOutputTokens = config.maxOutputTokens ?? 1_024;
    this.#timeoutMs = config.timeoutMs ?? 30_000;
  }

  async generate(request: FallbackRequest): Promise<FallbackResult> {
    try {
      const response = await axios.post(
        this.#endpoint,
        {
          model: this.#model,
          temperature: this.#temperature,
          max_tokens: this.#maxOutputTokens,
          messages: [
            { role: "system", content: this.#systemInstruction },
            { role: "user", content: buildFallbackPrompt(request) },
          ],
        },
        {
          timeout: this.#timeoutMs,
          headers: {
            "Content-Type": "application/json",
            ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}),
          },
        },
      );

      const text = extractOpenAICompatibleText(response.data);
      if (!text) {
        throw new JevFallbackError(
          "The custom fallback endpoint returned no recognizable text.",
          { provider: this.provider },
        );
      }
      return { text, provider: this.provider, model: this.#model };
    } catch (error) {
      if (error instanceof JevFallbackError) throw error;
      throw new JevFallbackError(
        `Custom fallback endpoint failed: ${error instanceof Error ? error.message : String(error)}`,
        { provider: this.provider, cause: error },
      );
    }
  }
}

function extractOpenAICompatibleText(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;

  const choices = record["choices"];
  if (Array.isArray(choices)) {
    const first = choices[0];
    if (first && typeof first === "object") {
      const message = (first as Record<string, unknown>)["message"];
      if (message && typeof message === "object") {
        const content = (message as Record<string, unknown>)["content"];
        if (typeof content === "string") return content;
      }
      const text = (first as Record<string, unknown>)["text"];
      if (typeof text === "string") return text;
    }
  }

  for (const key of ["text", "output", "completion", "content"]) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- *
 * Factory
 * -------------------------------------------------------------------------- */

function resolveProvider(config: JevFallbackConfig): FallbackProvider {
  if (config.provider) return config.provider;
  if (config.endpoint) return "custom";
  if (process.env["GEMINI_API_KEY"]) return "gemini";
  if (process.env["ANTHROPIC_API_KEY"]) return "anthropic";
  return "gemini";
}

function requireKey(
  provider: FallbackProvider,
  explicit: string | undefined,
): string {
  const envKey =
    provider === "anthropic" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY";
  const apiKey = explicit ?? process.env[envKey];
  if (!apiKey) {
    throw new JevShieldConfigError(
      `Fallback provider "${provider}" requires an API key. Pass \`fallback.apiKey\` or set ${envKey}.`,
    );
  }
  return apiKey;
}

/**
 * Builds the generative fallback that breaks the vendor lock-in documented as
 * weakness #5: when Jev is unavailable or unsure, JevShield can escalate to
 * Gemini Flash, Claude, or any OpenAI-compatible prose endpoint.
 */
export function createFallback(
  config: JevFallbackConfig = {},
): GenerativeFallback {
  const provider = resolveProvider(config);

  if (provider === "custom") {
    const endpoint =
      config.endpoint ?? process.env["JEVD_FALLBACK_ENDPOINT"];
    if (!endpoint) {
      throw new JevShieldConfigError(
        'Fallback provider "custom" requires `fallback.endpoint` or JEVD_FALLBACK_ENDPOINT.',
      );
    }
    return new CustomEndpointFallback(config, endpoint);
  }

  const apiKey = requireKey(provider, config.apiKey);
  return provider === "anthropic"
    ? new AnthropicFallback(config, apiKey)
    : new GeminiFallback(config, apiKey);
}
