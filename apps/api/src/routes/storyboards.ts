import { FastifyInstance } from "fastify";
import { z } from "zod";
import { validate } from "../middleware/validation.js";
import { requireScope } from "../middleware/auth.js";

const createStoryboardSchema = z.object({
  name: z.string().min(1).max(256),
});

const addClipSchema = z.object({
  objectId: z.string().uuid(),
  position: z.number().int().min(0).optional(),
  note: z.string().max(1024).optional(),
});

const updateClipSchema = z.object({
  position: z.number().int().min(0).optional(),
  note: z.string().max(1024).optional(),
});

const reorderClipsSchema = z.object({
  clipIds: z.array(z.string().uuid()).min(1),
});

export async function storyboardRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/storyboards",
    { preHandler: [validate({ body: createStoryboardSchema }), requireScope("write")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const crypto = await import("node:crypto");
      const { name } = request.body as z.infer<typeof createStoryboardSchema>;

      const id = crypto.randomUUID();
      await sql`
        INSERT INTO storyboards (id, org_id, name) VALUES (${id}, ${auth.orgId}, ${name})
      `;

      reply.status(201).send({ id, name });
    },
  );

  app.get(
    "/storyboards",
    { preHandler: [validate({}), requireScope("read")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const rows = await sql<{
        id: string;
        name: string;
        created_at: string;
        clip_count: string;
      }[]>`
        SELECT sb.id, sb.name, sb.created_at,
               COUNT(sc.id)::text as clip_count
        FROM storyboards sb
        LEFT JOIN storyboard_clips sc ON sc.storyboard_id = sb.id
        WHERE sb.org_id = ${auth.orgId}
        GROUP BY sb.id
        ORDER BY sb.created_at DESC
      `;

      return {
        storyboards: rows.map((r) => ({ ...r, clipCount: parseInt(r.clip_count, 10) })),
      };
    },
  );

  app.get(
    "/storyboards/:id",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }) }), requireScope("read")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id } = (request as any).validatedParams as { id: string };

      const sbRows = await sql<{ id: string; name: string; created_at: string }[]>`
        SELECT id, name, created_at FROM storyboards WHERE id = ${id} AND org_id = ${auth.orgId}
      `;

      if (sbRows.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Storyboard not found" } });
      }

      const clips = await sql`
        SELECT sc.id, sc.object_id, sc.position, sc.note,
               o.key as object_key, o.content_type, b.name as bucket_name
        FROM storyboard_clips sc
        JOIN objects o ON o.id = sc.object_id
        JOIN buckets b ON b.id = o.bucket_id
        WHERE sc.storyboard_id = ${id} AND o.deleted_at IS NULL
        ORDER BY sc.position ASC
      `;

      return { ...sbRows[0], clips };
    },
  );

  app.post(
    "/storyboards/:id/clips",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }), body: addClipSchema }), requireScope("write")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const crypto = await import("node:crypto");
      const { id } = (request as any).validatedParams as { id: string };
      const { objectId, position, note } = request.body as z.infer<typeof addClipSchema>;

      const sbExists = await sql<{ id: string }[]>`
        SELECT id FROM storyboards WHERE id = ${id} AND org_id = ${auth.orgId}
      `;
      if (sbExists.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Storyboard not found" } });
      }

      const obj = await sql<{ id: string }[]>`
        SELECT o.id FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        WHERE o.id = ${objectId} AND b.org_id = ${auth.orgId} AND o.deleted_at IS NULL
      `;
      if (obj.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Object not found" } });
      }

      const clipId = crypto.randomUUID();
      const pos = position ?? (await sql<{ max_pos: number | null }[]>`
        SELECT MAX(position) as max_pos FROM storyboard_clips WHERE storyboard_id = ${id}
      `)[0]!.max_pos ?? -1;

      await sql`
        INSERT INTO storyboard_clips (id, storyboard_id, object_id, position, note)
        VALUES (${clipId}, ${id}, ${objectId}, ${pos + 1}, ${note ?? null})
      `;

      reply.status(201).send({ id: clipId, storyboardId: id, objectId, position: pos + 1, note });
    },
  );

  app.put(
    "/storyboards/:id/clips/reorder",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }), body: reorderClipsSchema }), requireScope("write")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id } = (request as any).validatedParams as { id: string };
      const { clipIds } = request.body as z.infer<typeof reorderClipsSchema>;

      const sbExists = await sql<{ id: string }[]>`
        SELECT id FROM storyboards WHERE id = ${id} AND org_id = ${auth.orgId}
      `;
      if (sbExists.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Storyboard not found" } });
      }

      // All supplied ids must belong to this storyboard — reject partial/foreign sets.
      const owned = await sql<{ id: string }[]>`
        SELECT id FROM storyboard_clips WHERE storyboard_id = ${id} AND id = ANY(${clipIds})
      `;
      if (owned.length !== clipIds.length) {
        return reply.status(400).send({ error: { code: "BadRequest", message: "clipIds must all belong to this storyboard" } });
      }

      // Persist the new order atomically. Two-phase offset avoids any transient
      // unique-position collision if such a constraint is ever added.
      await sql.begin(async (tx) => {
        for (let i = 0; i < clipIds.length; i++) {
          await tx`UPDATE storyboard_clips SET position = ${i + 1000000} WHERE id = ${clipIds[i]!} AND storyboard_id = ${id}`;
        }
        for (let i = 0; i < clipIds.length; i++) {
          await tx`UPDATE storyboard_clips SET position = ${i} WHERE id = ${clipIds[i]!} AND storyboard_id = ${id}`;
        }
      });

      const clips = await sql`
        SELECT id, object_id, position, note FROM storyboard_clips
        WHERE storyboard_id = ${id} ORDER BY position ASC
      `;
      return { storyboardId: id, clips };
    },
  );

  app.put(
    "/storyboards/:id/clips/:clipId",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid(), clipId: z.string().uuid() }), body: updateClipSchema }), requireScope("write")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id, clipId } = (request as any).validatedParams as { id: string; clipId: string };
      const { position, note } = request.body as z.infer<typeof updateClipSchema>;

      const clip = await sql<{ id: string }[]>`
        SELECT sc.id FROM storyboard_clips sc
        JOIN storyboards sb ON sb.id = sc.storyboard_id
        WHERE sc.id = ${clipId} AND sc.storyboard_id = ${id} AND sb.org_id = ${auth.orgId}
      `;
      if (clip.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Clip not found" } });
      }

      if (position !== undefined) {
        await sql`UPDATE storyboard_clips SET position = ${position} WHERE id = ${clipId}`;
      }
      if (note !== undefined) {
        await sql`UPDATE storyboard_clips SET note = ${note} WHERE id = ${clipId}`;
      }

      const updated = await sql`
        SELECT id, object_id, position, note FROM storyboard_clips WHERE id = ${clipId}
      `;
      return updated[0];
    },
  );

  app.delete(
    "/storyboards/:id/clips/:clipId",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid(), clipId: z.string().uuid() }) }), requireScope("delete")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id, clipId } = (request as any).validatedParams as { id: string; clipId: string };

      const result = await sql`
        DELETE FROM storyboard_clips
        WHERE id = ${clipId}
          AND storyboard_id = ${id}
          AND storyboard_id IN (SELECT id FROM storyboards WHERE org_id = ${auth.orgId})
      `;

      if (result.count === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Clip not found" } });
      }

      return { status: "deleted" };
    },
  );

  app.delete(
    "/storyboards/:id",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }) }), requireScope("delete")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id } = (request as any).validatedParams as { id: string };

      const result = await sql`
        DELETE FROM storyboards WHERE id = ${id} AND org_id = ${auth.orgId}
      `;

      if (result.count === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Storyboard not found" } });
      }

      return { status: "deleted" };
    },
  );
}
