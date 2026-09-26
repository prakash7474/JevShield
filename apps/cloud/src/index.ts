import Fastify from "fastify";
import cors from "@fastify/cors";
import { Redis } from "ioredis";
import { PrismaClient } from "@prisma/client";

import { setupTelemetry } from "./telemetry/otel.js";
import { registerGatewayRoutes } from "./gateway/proxyServer.js";
import { registerHitlRoutes } from "./hitl/reviewQueue.js";
import { registerRegistryRoutes } from "./registry/questionRegistry.js";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const PORT = Number(process.env["PORT"]) || 4000;
const HOST = process.env["HOST"] || "0.0.0.0";
const REDIS_URL = process.env["REDIS_URL"] || "redis://localhost:6379";
const HITL_CONFIDENCE_THRESHOLD = Number(process.env["HITL_CONFIDENCE_THRESHOLD"]) || 0.70;
const RATE_LIMIT_MAX = Number(process.env["RATE_LIMIT_MAX"]) || 1000;
const RATE_LIMIT_WINDOW_SECONDS = Number(process.env["RATE_LIMIT_WINDOW_SECONDS"]) || 60;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times: number) {
    return Math.min(times * 200, 5000);
  },
});

redis.on("error", (err: Error) => {
  console.error("[Redis] Connection error:", err.message);
});

redis.on("connect", () => {
  console.log("[Redis] Connected");
});

const { metricsHandler } = await setupTelemetry({
  defaultLabels: { service: "jevshield-cloud" },
});

const fastify = Fastify({
  logger: {
    level: process.env["LOG_LEVEL"] || "info",
  },
});

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

await fastify.register(cors, {
  origin: process.env["CORS_ORIGIN"] || true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
});

// ---------------------------------------------------------------------------
// Metrics endpoint
// ---------------------------------------------------------------------------

fastify.get("/metrics", async (_request, reply) => {
  const metrics = await metricsHandler();
  return reply
    .header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
    .send(metrics);
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

await registerGatewayRoutes(fastify, {
  redis,
  prisma,
  typesafeApiKey: process.env["TYPESAFE_API_KEY"],
  geminiApiKey: process.env["GEMINI_API_KEY"],
  hitlConfidenceThreshold: HITL_CONFIDENCE_THRESHOLD,
  rateLimitMax: RATE_LIMIT_MAX,
  rateLimitWindowSeconds: RATE_LIMIT_WINDOW_SECONDS,
});

await registerHitlRoutes(fastify, { prisma, redis });
await registerRegistryRoutes(fastify, { prisma });

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string) {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  await fastify.close();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

try {
  await fastify.listen({ port: PORT, host: HOST });
  console.log(`[JevShield Cloud] Gateway listening on http://${HOST}:${PORT}`);
  console.log(`[JevShield Cloud] Metrics endpoint: http://${HOST}:${PORT}/metrics`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
