import type { SecurityVerdict } from "./types/index.js";

/** Base class for every error thrown by JevShield. */
export class JevShieldError extends Error {
  /** Stable machine-readable code, safe to switch on. */
  public readonly code: string;
  /** Whether the operation that failed is safe to retry. */
  public readonly retryable: boolean;
  /** Underlying cause, when one exists. */
  public override readonly cause?: unknown;

  constructor(
    message: string,
    options: { code: string; retryable?: boolean; cause?: unknown } = {
      code: "JEVD_ERROR",
    },
  ) {
    super(message);
    this.name = new.target.name;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Misconfiguration detected before any network call was made. */
export class JevShieldConfigError extends JevShieldError {
  constructor(message: string, cause?: unknown) {
    super(message, {
      code: "JEVD_CONFIG",
      cause,
    });
  }
}

/** The request never reached Jev, or the transport failed. */
export class JevTransportError extends JevShieldError {
  public readonly status?: number;

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, {
      code: "JEVD_TRANSPORT",
      retryable: true,
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
    if (options.status !== undefined) {
      this.status = options.status;
    }
  }
}

/** 401 — missing or invalid API key. */
export class JevAuthError extends JevShieldError {
  constructor(message = "TypeSafe rejected the API key (401).", cause?: unknown) {
    super(message, { code: "JEVD_AUTH", cause });
  }
}

/** 422 — the request body failed server-side validation. */
export class JevValidationError extends JevShieldError {
  public readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message, { code: "JEVD_VALIDATION" });
    if (details !== undefined) {
      this.details = details;
    }
  }
}

/** 429 — rate limit exceeded. */
export class JevRateLimitError extends JevShieldError {
  public readonly retryAfterMs?: number;

  constructor(message = "TypeSafe rate limit exceeded (429).", retryAfterMs?: number) {
    super(message, { code: "JEVD_RATE_LIMIT", retryable: true });
    if (retryAfterMs !== undefined) {
      this.retryAfterMs = retryAfterMs;
    }
  }
}

/** 529 — TypeSafe is temporarily overloaded. */
export class JevOverloadedError extends JevShieldError {
  constructor(message = "TypeSafe is temporarily overloaded (529).") {
    super(message, { code: "JEVD_OVERLOADED", retryable: true });
  }
}

/** The response body did not match the documented answer schema. */
export class JevResponseError extends JevShieldError {
  public readonly issues?: unknown;

  constructor(message: string, issues?: unknown) {
    super(message, { code: "JEVD_BAD_RESPONSE" });
    if (issues !== undefined) {
      this.issues = issues;
    }
  }
}

/** The injected adversarial guardrail fired. */
export class JevShieldSecurityError extends JevShieldError {
  public readonly verdict: SecurityVerdict;

  constructor(verdict: SecurityVerdict) {
    super(
      `Adversarial/content-injection attempt detected (p=${verdict.injectionProbability.toFixed(3)} >= ${verdict.threshold}).`,
      { code: "JEVD_INJECTION" },
    );
    this.verdict = verdict;
  }
}

/** A generative fallback was requested but could not be produced. */
export class JevFallbackError extends JevShieldError {
  public readonly provider?: string;

  constructor(message: string, options: { provider?: string; cause?: unknown } = {}) {
    super(message, {
      code: "JEVD_FALLBACK",
      retryable: true,
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
    if (options.provider !== undefined) {
      this.provider = options.provider;
    }
  }
}
