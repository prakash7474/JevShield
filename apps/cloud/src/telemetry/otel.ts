import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Histogram,
  Summary,
} from "prom-client";

// ---------------------------------------------------------------------------
// Shared registry
// ---------------------------------------------------------------------------

export const registry = new Registry();

// ---------------------------------------------------------------------------
// Prometheus metric definitions
// ---------------------------------------------------------------------------

export const jevLatencyHistogram = new Histogram({
  name: "jevshield_jev_latency_ms",
  help: "Latency of Jev System One classification calls in ms",
  buckets: [10, 50, 100, 200, 500, 1000, 2000, 5000],
  labelNames: ["model"] as const,
  registers: [registry],
});

export const geminiLatencyHistogram = new Histogram({
  name: "jevshield_gemini_latency_ms",
  help: "Latency of Gemini fallback calls in ms",
  buckets: [50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry],
});

export const confidenceHistogram = new Histogram({
  name: "jevshield_confidence_histogram",
  help: "Distribution of Jev confidence scores",
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99],
  registers: [registry],
});

export const securityBlocksCounter = new Counter({
  name: "jevshield_security_blocks_total",
  help: "Total count of prompt injection attempts blocked by JevShield",
  registers: [registry],
});

export const requestsTotalCounter = new Counter({
  name: "jevshield_requests_total",
  help: "Total number of evaluation requests received",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [registry],
});

export const hitlQueueGauge = new Summary({
  name: "jevshield_hitl_queue_size",
  help: "Current size of the HITL review queue",
  percentiles: [0.5, 0.9, 0.99],
  registers: [registry],
});

export const fallbackTriggerCounter = new Counter({
  name: "jevshield_fallback_triggers_total",
  help: "Total number of fallback escalations to Gemini or local LLM",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const quotaExceededCounter = new Counter({
  name: "jevshield_quota_exceeded_total",
  help: "Total number of requests rejected due to quota exhaustion",
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Calibration drift tracking
// ---------------------------------------------------------------------------

export const calibrationBuckets = new Counter({
  name: "jevshield_calibration_predictions_total",
  help: "Running tally of predictions by confidence bucket for drift detection",
  labelNames: ["bucket"] as const,
  registers: [registry],
});

export const calibrationCorrectTotal = new Counter({
  name: "jevshield_calibration_correct_total",
  help: "Running tally of correct predictions by confidence bucket",
  labelNames: ["bucket"] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Telemetry bootstrap
// ---------------------------------------------------------------------------

export interface TelemetryConfig {
  prefix?: string;
  defaultLabels?: Record<string, string>;
}

/**
 * Initialises prom-client default metrics and returns a /metrics handler
 * compatible with Fastify.
 */
export async function setupTelemetry(config: TelemetryConfig = {}) {
  const { prefix = "", defaultLabels = {} } = config;

  collectDefaultMetrics({
    prefix,
    register: registry,
    ...(Object.keys(defaultLabels).length > 0
      ? { labels: defaultLabels }
      : {}),
  });

  const metricsHandler = async () => {
    return registry.metrics();
  };

  return { registry, metricsHandler };
}
