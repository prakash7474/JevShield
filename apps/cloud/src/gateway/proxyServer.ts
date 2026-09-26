import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@prisma/client";

import {
  jevLatencyHistogram,
  geminiLatencyHistogram,
  confidenceHistogram,
  requestsTotalCounter,
  fallbackTriggerCounter,
  quotaExceededCounter,
} from "../telemetry/otel.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EvaluateBody {
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
  model?: string;
  metadata?: Record<string, unknown>;
}

interface GatewayConfig {
  redis: Redis;
  prisma: PrismaClient;
  typesafeApiKey?: string;
  geminiApiKey?: string;
  hitlConfidenceThreshold: number;
  rateLimitMax: number;
  rateLimitWindowSeconds: number;
}

// ---------------------------------------------------------------------------
// Rate limiter (sliding-window via Redis sorted sets)
// ---------------------------------------------------------------------------

async function checkRateLimit(
  redis: Redis,
  clientId: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;
  const key = `rl:${clientId}`;

  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zadd(key, now.toString(), `${now}:${crypto.randomUUID()}`);
  pipeline.zcard(key);
  pipeline.expire(key, windowSeconds);

  const results = await pipeline.exec();
  if (!results) {
    return { allowed: false, remaining: 0, retryAfterMs: windowSeconds * 1000 };
  }

  const count = (results[2]?.[1] as number) ?? 0;
  const allowed = count <= maxRequests;
  const remaining = Math.max(0, maxRequests - count);

  let retryAfterMs = 0;
  if (!allowed) {
    const oldest = await redis.zrange(key, 0, 0, "WITHSCORES");
    if (oldest.length >= 2) {
      retryAfterMs = Number(oldest[1]) + windowSeconds * 1000 - now;
    } else {
      retryAfterMs = windowSeconds * 1000;
    }
  }

  return { allowed, remaining, retryAfterMs: Math.max(0, retryAfterMs) };
}

// ---------------------------------------------------------------------------
// API key validation + quota check
// ---------------------------------------------------------------------------

async function validateApiKey(
  prisma: PrismaClient,
  redis: Redis,
  apiKeyHash: string,
): Promise<{ valid: boolean; dailyRemaining: number; name: string }> {
  const keyRecord = await prisma.apiKey.findUnique({
    where: { keyHash: apiKeyHash },
  });

  if (!keyRecord || !keyRecord.isActive) {
    return { valid: false, dailyRemaining: 0, name: "" };
  }

  const today = new Date().toISOString().slice(0, 10);
  const quotaKey = `quota:${apiKeyHash}:${today}`;
  const used = parseInt(await redis.get(quotaKey) ?? "0", 10);

  if (used >= keyRecord.dailyQuota) {
    return { valid: true, dailyRemaining: 0, name: keyRecord.name };
  }

  return {
    valid: true,
    dailyRemaining: keyRecord.dailyQuota - used,
    name: keyRecord.name,
  };
}

// ---------------------------------------------------------------------------
// Jev call with timeout + fallback
// ---------------------------------------------------------------------------

interface JevEvalPayload {
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
  model: string;
}

interface JevEvalResult {
  answers: Record<string, unknown>;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  latencyMs: number;
  isFallback: boolean;
  confidence: number;
}

async function callJevPrimary(
  payload: JevEvalPayload,
  apiKey: string,
  timeoutMs = 1500,
): Promise<JevEvalResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const start = Date.now();
  try {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Jev API returned ${res.status}`);
    }

    const data = (await res.json()) as {
      answers: Record<string, unknown>;
      model: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    const latencyMs = Date.now() - start;
    const confidence = computeAggregateConfidence(data.answers);

    return {
      answers: data.answers,
      model: data.model,
      usage: data.usage,
      latencyMs,
      isFallback: false,
      confidence,
    };
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

function computeAggregateConfidence(
  answers: Record<string, unknown>,
): number {
  let sum = 0;
  let count = 0;

  for (const answer of Object.values(answers)) {
    const a = answer as Record<string, unknown>;
    if (typeof a["confidence"] === "number") {
      sum += a["confidence"];
      count++;
    } else if (typeof a["noul"] === "number") {
      const noul = a["noul"] as number;
      sum += 1 - Math.abs(noul - 0.5) * 2;
      count++;
    }
  }

  return count > 0 ? sum / count : 0;
}

async function callGeminiFallback(
  payload: JevEvalPayload,
  apiKey: string,
): Promise<JevEvalResult> {
  const start = Date.now();
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `You are a classification engine. Given this state, answer each question.\n\nState: ${JSON.stringify(payload.state)}\n\nQuestions: ${JSON.stringify(payload.questions)}\n\nReturn a JSON object with question IDs as keys.`,
                },
              ],
            },
          ],
        }),
      },
    );

    const latencyMs = Date.now() - start;
    const data = (await res.json()) as Record<string, unknown>;
    const candidates = data["candidates"] as Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
    const text = candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

    const parsed = JSON.parse(text) as Record<string, unknown>;

    return {
      answers: parsed,
      model: "gemini-2.0-flash",
      usage: { input_tokens: 0, output_tokens: 0 },
      latencyMs,
      isFallback: true,
      confidence: 0.75,
    };
  } catch (error) {
    const latencyMs = Date.now() - start;
    geminiLatencyHistogram.observe(latencyMs);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerGatewayRoutes(
  fastify: FastifyInstance,
  config: GatewayConfig,
): Promise<void> {
  const { redis, prisma, hitlConfidenceThreshold, rateLimitMax, rateLimitWindowSeconds } = config;

  // Healthcheck
  fastify.get("/health", async () => ({
    status: "ok",
    service: "jevshield-cloud-gateway",
    timestamp: new Date().toISOString(),
  }));

  // ── POST /v1/evaluate ──────────────────────────────────────────────────
  fastify.post<{ Body: EvaluateBody }>(
    "/v1/evaluate",
    {
      schema: {
        body: {
          type: "object",
          required: ["state", "questions"],
          properties: {
            state: { type: "object" },
            questions: { type: "object" },
            model: { type: "string" },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: EvaluateBody }>, reply: FastifyReply) => {
      const apiKey = request.headers["x-api-key"] as string | undefined;

      // 1. Validate API key
      if (!apiKey) {
        return reply.status(401).send({ error: "Missing X-Api-Key header" });
      }

      const keyHash = apiKey;
      const { valid, dailyRemaining, name: teamName } = await validateApiKey(
        prisma,
        redis,
        keyHash,
      );

      if (!valid) {
        return reply.status(403).send({ error: "Invalid or inactive API key" });
      }

      if (dailyRemaining <= 0) {
        quotaExceededCounter.inc();
        return reply.status(429).send({
          error: "Daily quota exhausted",
          team: teamName,
          resetAt: new Date(new Date().setHours(24, 0, 0, 0)).toISOString(),
        });
      }

      // 2. Sliding-window rate limit
      const clientId = keyHash;
      const { allowed, remaining, retryAfterMs } = await checkRateLimit(
        redis,
        clientId,
        rateLimitMax,
        rateLimitWindowSeconds,
      );

      if (!allowed) {
        return reply
          .status(429)
          .header("Retry-After", Math.ceil(retryAfterMs / 1000).toString())
          .header("X-RateLimit-Remaining", "0")
          .send({ error: "Rate limit exceeded", retryAfterMs });
      }

      // 3. Call Jev primary with timeout failover
      let result: JevEvalResult;
      const { state, questions, model } = request.body;

      try {
        result = await callJevPrimary(
          { state, questions, model: model ?? "jev-latest" },
          config.typesafeApiKey ?? process.env["TYPESAFE_API_KEY"] ?? "",
        );
      } catch (primaryError) {
        fallbackTriggerCounter.inc({ reason: "primary-error" });

        if (!config.geminiApiKey && !process.env["GEMINI_API_KEY"]) {
          requestsTotalCounter.inc({ method: "POST", route: "/v1/evaluate", status_code: "502" });
          return reply.status(502).send({
            error: "Primary and fallback providers unavailable",
            details: primaryError instanceof Error ? primaryError.message : "unknown",
          });
        }

        try {
          result = await callGeminiFallback(
            { state, questions, model: model ?? "jev-latest" },
            config.geminiApiKey ?? process.env["GEMINI_API_KEY"] ?? "",
          );
        } catch {
          requestsTotalCounter.inc({ method: "POST", route: "/v1/evaluate", status_code: "503" });
          return reply.status(503).send({
            error: "Both primary and fallback providers failed",
          });
        }
      }

      // 4. Record metrics
      if (result.isFallback) {
        geminiLatencyHistogram.observe(result.latencyMs);
      } else {
        jevLatencyHistogram.observe({ model: result.model }, result.latencyMs);
      }

      confidenceHistogram.observe(result.confidence);

      // 5. Hitl check — route low-confidence to review queue
      const hitlThreshold = Number(process.env["HITL_CONFIDENCE_THRESHOLD"]) || hitlConfidenceThreshold;
      if (result.confidence < hitlThreshold) {
        try {
          const questionSet = await prisma.questionSet.findFirst({
            where: { isActive: true },
            orderBy: { createdAt: "desc" },
          });

          await prisma.hitlReview.create({
            data: {
              statePayload: state as unknown as Record<string, string>,
              questionSetId: questionSet?.id ?? "default",
              confidenceScore: result.confidence,
              hazardScore: 0,
              reason: "low-confidence",
            },
          });
        } catch {
          // Non-fatal: log and continue
        }
      }

      // 6. Increment quota counter
      const today = new Date().toISOString().slice(0, 10);
      const quotaKey = `quota:${keyHash}:${today}`;
      await redis.incr(quotaKey);
      await redis.expire(quotaKey, 86400);

      // 7. Audit log (non-blocking)
      prisma.auditLog
        .create({
          data: {
            clientApiKeyHash: keyHash,
            endpoint: "/v1/evaluate",
            stateHash: JSON.stringify(state).slice(0, 64),
            jevLatencyMs: result.latencyMs,
            isFallback: result.isFallback,
            confidenceScore: result.confidence,
          },
        })
        .catch(() => {
          // Non-fatal
        });

      requestsTotalCounter.inc({ method: "POST", route: "/v1/evaluate", status_code: "200" });

      return reply.send({
        success: true,
        model: result.model,
        answers: result.answers,
        usage: result.usage,
        confidence: result.confidence,
        latencyMs: result.latencyMs,
        isFallback: result.isFallback,
        rateLimit: { remaining, resetMs: rateLimitWindowSeconds * 1000 },
        quota: { remaining: dailyRemaining - 1 },
      });
    },
  );

  // ── POST /v1/evaluate/batch ────────────────────────────────────────────
  fastify.post<{ Body: { requests: EvaluateBody[] } }>(
    "/v1/evaluate/batch",
    {
      schema: {
        body: {
          type: "object",
          required: ["requests"],
          properties: {
            requests: {
              type: "array",
              maxItems: 50,
              items: {
                type: "object",
                required: ["state", "questions"],
                properties: {
                  state: { type: "object" },
                  questions: { type: "object" },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: { requests: EvaluateBody[] } }>, reply: FastifyReply) => {
      const apiKey = request.headers["x-api-key"] as string | undefined;
      if (!apiKey) {
        return reply.status(401).send({ error: "Missing X-Api-Key header" });
      }

      const keyHash = apiKey;
      const { valid, dailyRemaining } = await validateApiKey(prisma, redis, keyHash);
      if (!valid) {
        return reply.status(403).send({ error: "Invalid API key" });
      }

      if (dailyRemaining < request.body.requests.length) {
        quotaExceededCounter.inc();
        return reply.status(429).send({ error: "Insufficient quota for batch" });
      }

      const { allowed } = await checkRateLimit(redis, keyHash, rateLimitMax, rateLimitWindowSeconds);
      if (!allowed) {
        return reply.status(429).send({ error: "Rate limit exceeded" });
      }

      const results = await Promise.allSettled(
        request.body.requests.map(async (req) => {
          try {
            return await callJevPrimary(
              { state: req.state, questions: req.questions, model: req.model ?? "jev-latest" },
              config.typesafeApiKey ?? process.env["TYPESAFE_API_KEY"] ?? "",
            );
          } catch {
            fallbackTriggerCounter.inc({ reason: "batch-primary-error" });
            if (process.env["GEMINI_API_KEY"]) {
              return await callGeminiFallback(
                { state: req.state, questions: req.questions, model: "jev-latest" },
                process.env["GEMINI_API_KEY"],
              );
            }
            throw new Error("No fallback available");
          }
        }),
      );

      return reply.send({
        results: results.map((r) =>
          r.status === "fulfilled"
            ? { success: true, ...r.value }
            : { success: false, error: r.reason?.message ?? "Unknown error" },
        ),
      });
    },
  );
}
