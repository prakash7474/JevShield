import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { PrismaClient, ReviewStatus } from "@prisma/client";
import type { Redis } from "ioredis";
import { z } from "zod";

import { hitlQueueGauge } from "../telemetry/otel.js";

// ---------------------------------------------------------------------------
// Zod schemas for request validation
// ---------------------------------------------------------------------------

const ResolveBodySchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["APPROVED", "OVERRIDDEN", "REJECTED"]),
  reviewerComment: z.string().optional(),
  overrideChoice: z.string().optional(),
  reviewerId: z.string().optional(),
});

const PendingQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .enum(["PENDING", "APPROVED", "OVERRIDDEN", "REJECTED"])
    .optional()
    .default("PENDING"),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HitlConfig {
  prisma: PrismaClient;
  redis: Redis;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerHitlRoutes(
  fastify: FastifyInstance,
  config: HitlConfig,
): Promise<void> {
  const { prisma, redis } = config;

  // ── GET /v1/hitl/pending ───────────────────────────────────────────────
  fastify.get(
    "/v1/hitl/pending",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = PendingQuerySchema.parse(request.query);
      const skip = (query.page - 1) * query.limit;

      const [items, total] = await Promise.all([
        prisma.hitlReview.findMany({
          where: { status: query.status as ReviewStatus },
          include: { questionSet: { select: { name: true, version: true } } },
          orderBy: { createdAt: "asc" },
          skip,
          take: query.limit,
        }),
        prisma.hitlReview.count({
          where: { status: query.status as ReviewStatus },
        }),
      ]);

      hitlQueueGauge.observe(total);

      return reply.send({
        items,
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          pages: Math.ceil(total / query.limit),
        },
      });
    },
  );

  // ── GET /v1/hitl/stats ─────────────────────────────────────────────────
  fastify.get("/v1/hitl/stats", async (_request: FastifyRequest, reply: FastifyReply) => {
    const [pending, approved, overridden, rejected, avgConfidence] =
      await Promise.all([
        prisma.hitlReview.count({ where: { status: "PENDING" } }),
        prisma.hitlReview.count({ where: { status: "APPROVED" } }),
        prisma.hitlReview.count({ where: { status: "OVERRIDDEN" } }),
        prisma.hitlReview.count({ where: { status: "REJECTED" } }),
        prisma.hitlReview.aggregate({
          where: { status: "PENDING" },
          _avg: { confidenceScore: true },
        }),
      ]);

    return reply.send({
      pending,
      approved,
      overridden,
      rejected,
      averageConfidence: avgConfidence._avg.confidenceScore ?? 0,
    });
  });

  // ── GET /v1/hitl/:id ───────────────────────────────────────────────────
  fastify.get(
    "/v1/hitl/:id",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const item = await prisma.hitlReview.findUnique({
        where: { id },
        include: { questionSet: true },
      });

      if (!item) {
        return reply.status(404).send({ error: "Review not found" });
      }

      return reply.send(item);
    },
  );

  // ── POST /v1/hitl/resolve ──────────────────────────────────────────────
  fastify.post(
    "/v1/hitl/resolve",
    {
      schema: {
        body: {
          type: "object",
          required: ["id", "status"],
          properties: {
            id: { type: "string" },
            status: { type: "string", enum: ["APPROVED", "OVERRIDDEN", "REJECTED"] },
            reviewerComment: { type: "string" },
            overrideChoice: { type: "string" },
            reviewerId: { type: "string" },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ResolveBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { id, status, reviewerComment, overrideChoice, reviewerId } =
        parsed.data;

      const existing = await prisma.hitlReview.findUnique({ where: { id } });
      if (!existing) {
        return reply.status(404).send({ error: "Review not found" });
      }

      if (existing.status !== "PENDING") {
        return reply.status(409).send({
          error: `Review already resolved with status: ${existing.status}`,
        });
      }

      if (status === "OVERRIDDEN" && !overrideChoice) {
        return reply.status(400).send({
          error: "overrideChoice is required when status is OVERRIDDEN",
        });
      }

      const updated = await prisma.hitlReview.update({
        where: { id },
        data: {
          status,
          reviewerComment: reviewerComment ?? null,
          overrideChoice: overrideChoice ?? null,
          reviewerId: reviewerId ?? null,
          resolvedAt: new Date(),
        },
      });

      // Invalidate cached queue size
      await redis.del("hitl:queue:count");

      // Store the correction for regression testing
      if (status === "OVERRIDDEN" || status === "REJECTED") {
        const correctionKey = `hitl:corrections:${existing.questionSetId}`;
        await redis.lpush(
          correctionKey,
          JSON.stringify({
            reviewId: id,
            originalConfidence: existing.confidenceScore,
            overrideChoice,
            status,
            timestamp: Date.now(),
          }),
        );
        await redis.ltrim(correctionKey, 0, 999); // Keep last 1000 corrections
      }

      return reply.send({ success: true, review: updated });
    },
  );

  // ── POST /v1/hitl/bulk-resolve ─────────────────────────────────────────
  fastify.post(
    "/v1/hitl/bulk-resolve",
    {
      schema: {
        body: {
          type: "object",
          required: ["ids", "status"],
          properties: {
            ids: { type: "array", items: { type: "string" }, maxItems: 100 },
            status: { type: "string", enum: ["APPROVED", "REJECTED"] },
            reviewerComment: { type: "string" },
            reviewerId: { type: "string" },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as {
        ids: string[];
        status: "APPROVED" | "REJECTED";
        reviewerComment?: string;
        reviewerId?: string;
      };

      const result = await prisma.hitlReview.updateMany({
        where: {
          id: { in: body.ids },
          status: "PENDING",
        },
        data: {
          status: body.status,
          reviewerComment: body.reviewerComment ?? null,
          reviewerId: body.reviewerId ?? null,
          resolvedAt: new Date(),
        },
      });

      await redis.del("hitl:queue:count");

      return reply.send({
        success: true,
        updated: result.count,
      });
    },
  );
}
