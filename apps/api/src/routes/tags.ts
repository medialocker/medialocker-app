import { FastifyInstance } from "fastify";
import { z } from "zod";
import { validate } from "../middleware/validation.js";
import { requireScope } from "../middleware/auth.js";
import { refreshSearchIndex } from "../lib/search-index.js";

const createTagSchema = z.object({
  name: z.string().min(1).max(128),
});

const setTagsSchema = z.object({
  tagIds: z.array(z.string().uuid()),
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function tagRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/tags",
    { preHandler: [validate({ body: createTagSchema }), requireScope("write")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const crypto = await import("node:crypto");
      const { name } = request.body as z.infer<typeof createTagSchema>;

      const slug = slugify(name);
      if (!slug) {
        return reply.status(400).send({ error: { code: "InvalidArgument", message: "Tag name must contain at least one alphanumeric character." } });
      }
      const id = crypto.randomUUID();

      try {
        await sql`
          INSERT INTO tags (id, org_id, name, slug) VALUES (${id}, ${auth.orgId}, ${name}, ${slug})
        `;
      } catch {
        return reply.status(409).send({ error: { code: "Conflict", message: "Tag with this name already exists" } });
      }

      reply.status(201).send({ id, name, slug });
    },
  );

  app.get(
    "/tags",
    { preHandler: [validate({ query: z.object({ search: z.string().optional() }) }), requireScope("read")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const q = (request as any).validatedQuery as { search?: string };

      let tags;
      if (q.search) {
        tags = await sql<{ id: string; name: string; slug: string; object_count: string }[]>`
          SELECT t.id, t.name, t.slug, COUNT(ot.object_id)::text as object_count
          FROM tags t
          LEFT JOIN object_tags ot ON ot.tag_id = t.id
          WHERE t.org_id = ${auth.orgId} AND t.name ILIKE ${"%" + q.search + "%"}
          GROUP BY t.id
          ORDER BY t.name
        `;
      } else {
        tags = await sql<{ id: string; name: string; slug: string; object_count: string }[]>`
          SELECT t.id, t.name, t.slug, COUNT(ot.object_id)::text as object_count
          FROM tags t
          LEFT JOIN object_tags ot ON ot.tag_id = t.id
          WHERE t.org_id = ${auth.orgId}
          GROUP BY t.id
          ORDER BY t.name
        `;
      }

      return {
        tags: tags.map((t) => ({ ...t, objectCount: parseInt(t.object_count, 10) })),
      };
    },
  );

  app.put(
    "/objects/:id/tags",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }), body: setTagsSchema }), requireScope("write")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id } = (request as any).validatedParams as { id: string };
      const { tagIds } = request.body as z.infer<typeof setTagsSchema>;

      const obj = await sql`
        SELECT o.id FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        WHERE o.id = ${id} AND b.org_id = ${auth.orgId} AND o.deleted_at IS NULL
      `;
      if (obj.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Object not found" } });
      }

      const validTags = await sql<{ id: string }[]>`
        SELECT id FROM tags WHERE id = ANY(${tagIds}) AND org_id = ${auth.orgId}
      `;

      await sql`DELETE FROM object_tags WHERE object_id = ${id}`;

      if (validTags.length > 0) {
        const rows = validTags.map((t) => ({ object_id: id, tag_id: t.id }));
        await sql`INSERT INTO object_tags ${sql(rows, "object_id", "tag_id")}`;
      }

      await refreshSearchIndex(sql, id);

      const assigned = await sql`
        SELECT t.id, t.name, t.slug FROM tags t
        JOIN object_tags ot ON ot.tag_id = t.id
        WHERE ot.object_id = ${id}
      `;

      return { objectId: id, tags: assigned };
    },
  );

  app.delete(
    "/tags/:id",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }) }), requireScope("delete")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id } = (request as any).validatedParams as { id: string };

      const tag = await sql<{ id: string }[]>`
        SELECT id FROM tags WHERE id = ${id} AND org_id = ${auth.orgId}
      `;
      if (tag.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Tag not found" } });
      }

      await sql`DELETE FROM object_tags WHERE tag_id = ${id}`;
      await sql`DELETE FROM tags WHERE id = ${id} AND org_id = ${auth.orgId}`;

      return { status: "deleted" };
    },
  );
}
