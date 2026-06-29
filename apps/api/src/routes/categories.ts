import { FastifyInstance } from "fastify";
import { z } from "zod";
import { validate } from "../middleware/validation.js";
import { requireScope } from "../middleware/auth.js";
import { refreshSearchIndex } from "../lib/search-index.js";

const createCategorySchema = z.object({
  name: z.string().min(1).max(128),
  parentId: z.string().uuid().optional(),
});

const setCategoriesSchema = z.object({
  categoryIds: z.array(z.string().uuid()),
});

export async function categoryRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/categories",
    { preHandler: [validate({ body: createCategorySchema }), requireScope("write")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const crypto = await import("node:crypto");
      const { name, parentId } = request.body as z.infer<typeof createCategorySchema>;

      if (parentId) {
        const parent = await sql<{ id: string }[]>`
          SELECT id FROM categories WHERE id = ${parentId} AND org_id = ${auth.orgId}
        `;
        if (parent.length === 0) {
          return reply.status(404).send({ error: { code: "NotFound", message: "Parent category not found" } });
        }
      }

      const id = crypto.randomUUID();
      try {
        await sql`
          INSERT INTO categories (id, org_id, name, parent_id) VALUES (${id}, ${auth.orgId}, ${name}, ${parentId ?? null})
        `;
      } catch {
        return reply.status(409).send({ error: { code: "Conflict", message: "Category already exists" } });
      }

      reply.status(201).send({ id, name, parentId: parentId ?? null });
    },
  );

  app.get(
    "/categories",
    { preHandler: [validate({}), requireScope("read")] },
    async (request, reply) => {
      const { sql, auth } = request;

      const rows = await sql<{
        id: string;
        name: string;
        parent_id: string | null;
        object_count: string;
      }[]>`
        SELECT c.id, c.name, c.parent_id,
               COUNT(oc.object_id)::text as object_count
        FROM categories c
        LEFT JOIN object_categories oc ON oc.category_id = c.id
        WHERE c.org_id = ${auth.orgId}
        GROUP BY c.id
        ORDER BY c.name
      `;

      const catMap = new Map<string, any>();
      const roots: any[] = [];

      for (const row of rows) {
        const cat = { id: row.id, name: row.name, parentId: row.parent_id, objectCount: parseInt(row.object_count, 10), children: [] as any[] };
        catMap.set(row.id, cat);
      }

      for (const [, cat] of catMap) {
        if (cat.parentId && catMap.has(cat.parentId)) {
          catMap.get(cat.parentId)!.children.push(cat);
        } else {
          roots.push(cat);
        }
      }

      return { categories: roots };
    },
  );

  app.put(
    "/objects/:id/categories",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }), body: setCategoriesSchema }), requireScope("write")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id } = (request as any).validatedParams as { id: string };
      const { categoryIds } = request.body as z.infer<typeof setCategoriesSchema>;

      const obj = await sql`
        SELECT o.id FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        WHERE o.id = ${id} AND b.org_id = ${auth.orgId} AND o.deleted_at IS NULL
      `;
      if (obj.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Object not found" } });
      }

      const validCategories = await sql<{ id: string }[]>`
        SELECT id FROM categories WHERE id = ANY(${categoryIds}) AND org_id = ${auth.orgId}
      `;

      await sql`DELETE FROM object_categories WHERE object_id = ${id}`;

      if (validCategories.length > 0) {
        const rows = validCategories.map((c) => ({ object_id: id, category_id: c.id }));
        await sql`INSERT INTO object_categories ${sql(rows, "object_id", "category_id")}`;
      }

      await refreshSearchIndex(sql, id);

      const assigned = await sql`
        SELECT c.id, c.name FROM categories c
        JOIN object_categories oc ON oc.category_id = c.id
        WHERE oc.object_id = ${id}
      `;

      return { objectId: id, categories: assigned };
    },
  );

  app.delete(
    "/categories/:id",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }) }), requireScope("delete")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id } = (request as any).validatedParams as { id: string };

      const cat = await sql<{ id: string }[]>`
        SELECT id FROM categories WHERE id = ${id} AND org_id = ${auth.orgId}
      `;
      if (cat.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Category not found" } });
      }

      await sql`DELETE FROM object_categories WHERE category_id = ${id}`;
      await sql`UPDATE categories SET parent_id = NULL WHERE parent_id = ${id} AND org_id = ${auth.orgId}`;
      await sql`DELETE FROM categories WHERE id = ${id} AND org_id = ${auth.orgId}`;

      return { status: "deleted" };
    },
  );
}
