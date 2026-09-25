import axios, { type AxiosInstance } from "axios";
import pRetry, { AbortError } from "p-retry";

import {
  JevAuthError,
  JevOverloadedError,
  JevRateLimitError,
  JevShieldConfigError,
  JevShieldError,
  JevTransportError,
  JevValidationError,
} from "../errors.js";
import type {
  JevQuestions,
  JevRequestPayload,
  JevResponse,
  JevRetryConfig,
  JevShieldLogger,
  JevState,
} from "../types/index.js";
import { DEFAULT_RETRY_CONFIG } from "../types/index.js";
import { parseJevResponse, validateQuestions } from "./schemas.js";

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const SYSTEM_ONE_PATH = "/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";

export interface JevClientOptions {
  /** Defaults to `process.env.TYPESAFE_API_KEY`. */
  apiKey?: string;
  /** Defaults to `process.env.TYPESAFE_BASE_URL` or {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
  /** Defaults to `process.env.JEVD_MODEL` or {@link DEFAULT_MODEL}. */
  model?: string;
  /** Per-request timeout in ms. Default `60_000`. */
  timeoutMs?: number;
  retryConfig?: Partial<JevRetryConfig>;
  logger?: JevShieldLogger;
  /** Escape hatch for tests and custom transports. */
  httpClient?: AxiosInstance;
}

interface Classification {
  retryable: boolean;
  error: JevShieldError;
}

function extractMessage(body: unknown): string | undefined {
  if (typeof body === "string") return body.slice(0, 500);
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const nested = record["error"];
    if (nested && typeof nested === "object") {
      const message = (nested as Record<string, unknown>)["message"];
      if (typeof message === "string") return message;
    }
    if (typeof record["message"] === "string") return record["message"];
  }
  return undefined;
}

function parseRetryAfter(headers: unknown): number | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const getter = (headers as { get?: (key: string) => unknown }).get;
  const raw =
    typeof getter === "function"
      ? getter.call(headers, "retry-after")
      : (headers as Record<string, unknown>)["retry-after"];
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds * 1_000 : undefined;
}

/**
 * Maps any thrown value onto a typed JevShield error and decides whether the
 * attempt is worth repeating (429, 529, 5xx, transport failures only).
 */
function classifyError(error: unknown): Classification {
  if (error instanceof JevShieldError) {
    return { retryable: error.retryable, error };
  }

  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const body = error.response?.data;
    const message = extractMessage(body) ?? error.message;

    if (status === 401) {
      return { retryable: false, error: new JevAuthError(message, error) };
    }
    if (status === 422) {
      return { retryable: false, error: new JevValidationError(message, body) };
    }
    if (status === 429) {
      return {
        retryable: true,
        error: new JevRateLimitError(message, parseRetryAfter(error.response?.headers)),
      };
    }
    if (status === 529) {
      return { retryable: true, error: new JevOverloadedError(message) };
    }
    if (typeof status === "number" && status >= 500) {
      return {
        retryable: true,
        error: new JevTransportError(`TypeSafe returned HTTP ${status}.`, {
          status,
          cause: error,
        }),
      };
    }
    if (typeof status === "number") {
      return {
        retryable: false,
        error: new JevValidationError(
          `TypeSafe rejected the request (HTTP ${status}): ${message}`,
          body,
        ),
      };
    }
    return {
      retryable: true,
      error: new JevTransportError(
        `Could not reach TypeSafe: ${error.message}`,
        { cause: error },
      ),
    };
  }

  return {
    retryable: false,
    error: new JevShieldError(
      error instanceof Error ? error.message : "Unknown Jev client failure.",
      { code: "JEVD_UNKNOWN", cause: error },
    ),
  };
}

/**
 * Thin, retrying transport for `POST /v1/systemone`.
 *
 * Retry policy follows TypeSafe's guidance: 429, 529, 5xx and transport
 * failures are retried with exponential backoff; 401 and 422 fail fast because
 * repeating them can only produce the same answer.
 */
export class JevClient {
  readonly #http: AxiosInstance;
  readonly #model: string;
  readonly #retry: JevRetryConfig;
  readonly #logger: JevShieldLogger | undefined;

  constructor(options: JevClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env["TYPESAFE_API_KEY"];
    if (!apiKey) {
      throw new JevShieldConfigError(
        "No TypeSafe API key found. Pass `apiKey` or set TYPESAFE_API_KEY.",
      );
    }

    this.#model =
      options.model ?? process.env["JEVD_MODEL"] ?? DEFAULT_MODEL;
    this.#retry = { ...DEFAULT_RETRY_CONFIG, ...options.retryConfig };
    this.#logger = options.logger;

    this.#http =
      options.httpClient ??
      axios.create({
        baseURL:
          options.baseUrl ?? process.env["TYPESAFE_BASE_URL"] ?? DEFAULT_BASE_URL,
        timeout: options.timeoutMs ?? 60_000,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      });
  }

  /** The model alias used when a request does not override it. */
  get model(): string {
    return this.#model;
  }

  /** Evaluates a fully-formed request body. */
  async evaluate(payload: JevRequestPayload): Promise<JevResponse> {
    validateQuestions(payload.questions);
    return this.#send({
      state: payload.state,
      model: payload.model || this.#model,
      questions: payload.questions,
    });
  }

  /** Convenience wrapper around {@link evaluate}. */
  async decide(
    questions: JevQuestions,
    state: JevState,
    options: { model?: string } = {},
  ): Promise<JevResponse> {
    return this.evaluate({
      state,
      questions,
      model: options.model ?? this.#model,
    });
  }

  async #send(body: JevRequestPayload): Promise<JevResponse> {
    const attempt = async (): Promise<JevResponse> => {
      try {
        const response = await this.#http.post<unknown>(SYSTEM_ONE_PATH, body);
        return parseJevResponse(response.data);
      } catch (error) {
        const { retryable, error: wrapped } = classifyError(error);
        if (!retryable || !this.#retry.retryOnServerErrors || this.#retry.retries === 0) {
          // AbortError stops p-retry and rejects with the typed error.
          throw new AbortError(wrapped);
        }
        throw wrapped;
      }
    };

    return pRetry(attempt, {
      retries: this.#retry.retries,
      factor: this.#retry.factor,
      minTimeout: this.#retry.minTimeoutMs,
      maxTimeout: this.#retry.maxTimeoutMs,
      onFailedAttempt: (context) => {
        this.#logger?.warn?.(
          `Jev request failed (attempt ${context.attemptNumber}, ${context.retriesLeft} retries left): ${context.error.message}`,
        );
      },
    });
  }
}

/** @see {@link JevClient} */
export function createJevClient(options: JevClientOptions = {}): JevClient {
  return new JevClient(options);
}
