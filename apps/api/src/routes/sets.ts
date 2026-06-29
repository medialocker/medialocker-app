import { FastifyInstance } from "fastify";
import { z } from "zod";
import { validate } from "../middleware/validation.js";
import { requireScope } from "../middleware/auth.js";
import { getVariantQueue } from "../lib/queues.js";

const createSetSchema = z.object({
  name: z.string().min(1).max(256),
  baseObjectId: z.string().uuid().optional(),
});

const addItemSchema = z.object({
  objectId: z.string().uuid(),
  aspectRatio: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  role: z.string().optional(),
});

export async function setRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/sets",
    { preHandler: [validate({ body: createSetSchema }), requireScope("write")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const crypto = await import("node:crypto");
      const { name, baseObjectId } = request.body as z.infer<typeof createSetSchema>;

      const id = crypto.randomUUID();
      if (baseObjectId) {
        const objRows = await sql<{ id: string }[]>`
          SELECT o.id FROM objects o
          JOIN buckets b ON b.id = o.bucket_id
          WHERE o.id = ${baseObjectId} AND b.org_id = ${auth.orgId} AND o.deleted_at IS NULL
          LIMIT 1
        `;
        if (objRows.length === 0) {
          return reply.status(400).send({ error: { code: "InvalidArgument", message: "baseObjectId does not belong to this organization" } });
        }
      }
      await sql`
        INSERT INTO sets (id, org_id, name, base_object_id)
        VALUES (${id}, ${auth.orgId}, ${name}, ${baseObjectId ?? null})
      `;

      reply.status(201).send({ id, name, baseObjectId: baseObjectId ?? null });
    },
  );

  app.get(
    "/sets",
    { preHandler: [validate({}), requireScope("read")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const rows = await sql<{
        id: string;
        name: string;
        base_object_id: string | null;
        created_at: string;
        item_count: string;
      }[]>`
        SELECT s.id, s.name, s.base_object_id, s.created_at,
               COUNT(si.id)::text as item_count
        FROM sets s
        LEFT JOIN set_items si ON si.set_id = s.id
        WHERE s.org_id = ${auth.orgId}
        GROUP BY s.id
        ORDER BY s.created_at DESC
      `;

      return {
        sets: rows.map((r) => ({ ...r, itemCount: parseInt(r.item_count, 10), baseObjectId: r.base_object_id })),
      };
    },
  );

  app.get(
    "/sets/:id",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }) }), requireScope("read")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id } = (request as any).validatedParams as { id: string };

      const setRows = await sql<{
        id: string;
        name: string;
        base_object_id: string | null;
        created_at: string;
      }[]>`
        SELECT id, name, base_object_id, created_at
        FROM sets WHERE id = ${id} AND org_id = ${auth.orgId}
      `;

      if (setRows.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Set not found" } });
      }

      const items = await sql`
        SELECT si.id, si.set_id, si.object_id, si.aspect_ratio, si.width, si.height, si.role,
               o.key as object_key, o.content_type, b.name as bucket_name
        FROM set_items si
        JOIN objects o ON o.id = si.object_id
        JOIN buckets b ON b.id = o.bucket_id
        WHERE si.set_id = ${id} AND o.deleted_at IS NULL
        ORDER BY si.created_at
      `;

      return { ...setRows[0], baseObjectId: setRows[0]!.base_object_id, items };
    },
  );

  app.post(
    "/sets/:id/items",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }), body: addItemSchema }), requireScope("write")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const crypto = await import("node:crypto");
      const { id } = (request as any).validatedParams as { id: string };
      const { objectId, aspectRatio, width, height, role } = request.body as z.infer<typeof addItemSchema>;

      const setExists = await sql<{ id: string }[]>`
        SELECT id FROM sets WHERE id = ${id} AND org_id = ${auth.orgId}
      `;
      if (setExists.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Set not found" } });
      }

      const obj = await sql<{ id: string }[]>`
        SELECT o.id FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        WHERE o.id = ${objectId} AND b.org_id = ${auth.orgId} AND o.deleted_at IS NULL
      `;
      if (obj.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Object not found" } });
      }

      const itemId = crypto.randomUUID();
      await sql`
        INSERT INTO set_items (id, set_id, object_id, aspect_ratio, width, height, role)
        VALUES (${itemId}, ${id}, ${objectId}, ${aspectRatio ?? null}, ${width ?? null}, ${height ?? null}, ${role ?? null})
      `;

      reply.status(201).send({ id: itemId, set_id: id, object_id: objectId, aspectRatio, width, height, role });
    },
  );

  app.delete(
    "/sets/:id/items/:itemId",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid(), itemId: z.string().uuid() }) }), requireScope("delete")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id, itemId } = (request as any).validatedParams as { id: string; itemId: string };

      const result = await sql`
        DELETE FROM set_items
        WHERE id = ${itemId}
          AND set_id = ${id}
          AND set_id IN (SELECT id FROM sets WHERE org_id = ${auth.orgId})
      `;

      if (result.count === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Set item not found" } });
      }

      return { status: "deleted" };
    },
  );

  app.post(
    "/sets/:id/generate",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }) }), requireScope("write")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id } = (request as any).validatedParams as { id: string };

      const setExists = await sql<{ id: string }[]>`
        SELECT id FROM sets WHERE id = ${id} AND org_id = ${auth.orgId}
      `;
      if (setExists.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Set not found" } });
      }

      // C8: actually enqueue media:variant jobs — the route previously returned
      // "enqueued" while doing nothing. Pull each set item with everything the
      // worker's variant processor needs; items without target dims are skipped.
      // Same job shape + deterministic jobId as the MCP generate_variants tool.
      const items = await sql<{
        set_item_id: string;
        object_id: string;
        aspect_ratio: string | null;
        width: number | null;
        height: number | null;
        key: string;
        minio_bucket: string;
        kind: string | null;
      }[]>`
        SELECT si.id AS set_item_id, si.object_id, si.aspect_ratio, si.width, si.height,
               o.key, b.minio_bucket, ma.kind
          FROM set_items si
          JOIN objects o ON o.id = si.object_id
          JOIN buckets b ON b.id = o.bucket_id
          LEFT JOIN media_assets ma ON ma.object_id = o.id
         WHERE si.set_id = ${id} AND o.deleted_at IS NULL
      `;

      const queue = getVariantQueue();
      const enqueued: string[] = [];
      const skipped: string[] = [];
      for (const it of items) {
        if (!it.width || !it.height) { skipped.push(it.set_item_id); continue; }
        await queue.add(
          "media:variant",
          {
            objectId: it.object_id,
            orgId: auth.orgId,
            setItemId: it.set_item_id,
            minioBucket: it.minio_bucket,
            key: it.key,
            kind: it.kind ?? "other",
            targetWidth: it.width,
            targetHeight: it.height,
            aspectRatio: it.aspect_ratio ?? "1:1",
          },
          { jobId: `variant-${it.set_item_id}` }, // deterministic → idempotent re-runs
        );
        enqueued.push(it.set_item_id);
      }

      reply.status(202).send({
        status: "enqueued",
        message: `Variant generation enqueued for ${enqueued.length}/${items.length} item(s)`,
        setId: id,
        enqueuedCount: enqueued.length,
        skippedCount: skipped.length,
      });
    },
  );

  app.delete(
    "/sets/:id",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }) }), requireScope("delete")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id } = (request as any).validatedParams as { id: string };

      const result = await sql`
        DELETE FROM sets WHERE id = ${id} AND org_id = ${auth.orgId}
      `;

      if (result.count === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Set not found" } });
      }

      return { status: "deleted" };
    },
  );
}
