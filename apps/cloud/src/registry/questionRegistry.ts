import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const PublishBodySchema = z.object({
  name: z.string().min(1).max(256),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, "Must be valid SemVer (e.g. 1.0.0)"),
  schemaJson: z.record(z.unknown()),
  author: z.string().optional(),
  changelog: z.string().optional(),
});

const SyncQuerySchema = z.object({
  name: z.string().optional(),
  since: z.string().datetime().optional(),
  activeOnly: z.coerce.boolean().default(true),
});

const DiffQuerySchema = z.object({
  name: z.string(),
  from: z.string(),
  to: z.string(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegistryConfig {
  prisma: PrismaClient;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerRegistryRoutes(
  fastify: FastifyInstance,
  config: RegistryConfig,
): Promise<void> {
  const { prisma } = config;

  // ── GET /v1/registry/sets ──────────────────────────────────────────────
  fastify.get(
    "/v1/registry/sets",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = SyncQuerySchema.parse(request.query);

      const where: Record<string, unknown> = {};
      if (query.name) where.name = query.name;
      if (query.activeOnly) where.isActive = true;
      if (query.since) {
        where.createdAt = { gte: new Date(query.since) };
      }

      const sets = await prisma.questionSet.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 200,
      });

      return reply.send({ sets });
    },
  );

  // ── GET /v1/registry/sets/:name ────────────────────────────────────────
  fastify.get(
    "/v1/registry/sets/:name",
    async (
      request: FastifyRequest<{ Params: { name: string } }>,
      reply: FastifyReply,
    ) => {
      const { name } = request.params;

      const sets = await prisma.questionSet.findMany({
        where: { name },
        orderBy: { createdAt: "desc" },
      });

      if (sets.length === 0) {
        return reply.status(404).send({ error: `Question set "${name}" not found` });
      }

      return reply.send({ name, versions: sets });
    },
  );

  // ── GET /v1/registry/sets/:name/latest ─────────────────────────────────
  fastify.get(
    "/v1/registry/sets/:name/latest",
    async (
      request: FastifyRequest<{ Params: { name: string } }>,
      reply: FastifyReply,
    ) => {
      const { name } = request.params;

      const set = await prisma.questionSet.findFirst({
        where: { name, isActive: true },
        orderBy: { createdAt: "desc" },
      });

      if (!set) {
        return reply.status(404).send({ error: `No active version for "${name}"` });
      }

      return reply.send(set);
    },
  );

  // ── GET /v1/registry/sets/:name/diff ───────────────────────────────────
  fastify.get(
    "/v1/registry/sets/:name/diff",
    async (
      request: FastifyRequest<{ Params: { name: string }; Querystring: { from: string; to: string } }>,
      reply: FastifyReply,
    ) => {
      const { name } = request.params;
      const query = DiffQuerySchema.parse({ name, ...request.query });

      const [fromSet, toSet] = await Promise.all([
        prisma.questionSet.findUnique({
          where: { name_version: { name: query.name, version: query.from } },
        }),
        prisma.questionSet.findUnique({
          where: { name_version: { name: query.name, version: query.to } },
        }),
      ]);

      if (!fromSet) {
        return reply.status(404).send({ error: `Version ${query.from} not found` });
      }
      if (!toSet) {
        return reply.status(404).send({ error: `Version ${query.to} not found` });
      }

      const fromSchema = fromSet.schemaJson as unknown as Record<string, unknown>;
      const toSchema = toSet.schemaJson as unknown as Record<string, unknown>;

      const fromKeys = new Set(Object.keys(fromSchema));
      const toKeys = new Set(Object.keys(toSchema));

      const added = [...toKeys].filter((k) => !fromKeys.has(k));
      const removed = [...fromKeys].filter((k) => !toKeys.has(k));
      const modified = [...fromKeys].filter(
        (k) =>
          toKeys.has(k) &&
          JSON.stringify(fromSchema[k]) !== JSON.stringify(toSchema[k]),
      );

      return reply.send({
        name: query.name,
        from: query.from,
        to: query.to,
        changes: {
          added,
          removed,
          modified,
          addedCount: added.length,
          removedCount: removed.length,
          modifiedCount: modified.length,
        },
      });
    },
  );

  // ── POST /v1/registry/sets ─────────────────────────────────────────────
  fastify.post(
    "/v1/registry/sets",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "version", "schemaJson"],
          properties: {
            name: { type: "string" },
            version: { type: "string" },
            schemaJson: { type: "object" },
            author: { type: "string" },
            changelog: { type: "string" },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = PublishBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { name, version, schemaJson, author, changelog } = parsed.data;

      // Check for duplicate
      const existing = await prisma.questionSet.findUnique({
        where: { name_version: { name, version } },
      });

      if (existing) {
        return reply.status(409).send({
          error: `Version ${version} of "${name}" already exists`,
          id: existing.id,
        });
      }

      const set = await prisma.questionSet.create({
        data: {
          name,
          version,
          schemaJson: schemaJson as unknown as Prisma.InputJsonValue,
          author,
          changelog,
        },
      });

      return reply.status(201).send(set);
    },
  );

  // ── PUT /v1/registry/sets/:id/deactivate ───────────────────────────────
  fastify.put(
    "/v1/registry/sets/:id/deactivate",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const set = await prisma.questionSet.findUnique({ where: { id } });
      if (!set) {
        return reply.status(404).send({ error: "Question set not found" });
      }

      const updated = await prisma.questionSet.update({
        where: { id },
        data: { isActive: false },
      });

      return reply.send({ success: true, set: updated });
    },
  );

  // ── POST /v1/registry/sync ─────────────────────────────────────────────
  // Exposes a hook for SDKs and Studio to pull the latest production rules
  fastify.post(
    "/v1/registry/sync",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            names: {
              type: "array",
              items: { type: "string" },
              description: "Optional filter: only sync these question set names",
            },
            since: { type: "string", description: "ISO-8601 timestamp" },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { names?: string[]; since?: string };

      const where: Record<string, unknown> = { isActive: true };
      if (body.names && body.names.length > 0) {
        where.name = { in: body.names };
      }
      if (body.since) {
        where.updatedAt = { gte: new Date(body.since) };
      }

      const sets = await prisma.questionSet.findMany({
        where,
        orderBy: [{ name: "asc" }, { version: "desc" }],
      });

      // Deduplicate: keep only the latest active version per name
      const latestByName = new Map<string, (typeof sets)[number]>();
      for (const set of sets) {
        const existing = latestByName.get(set.name);
        if (!existing || set.version > existing.version) {
          latestByName.set(set.name, set);
        }
      }

      return reply.send({
        sets: [...latestByName.values()],
        syncedAt: new Date().toISOString(),
        count: latestByName.size,
      });
    },
  );
}
