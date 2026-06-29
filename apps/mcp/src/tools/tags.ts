import { z } from "zod";
import { ToolHandlerContext } from "./types.js";

export function registerTagTools(registerTool: (tool: any) => void): void {
  registerTool({
    name: "manage_tags",
    description: "Create, list, or assign tags to media objects. Action: 'create', 'list', or 'assign'.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "assign"], description: "Action to perform" },
        name: { type: "string", description: "Tag name (for create action)" },
        objectId: { type: "string", description: "Object ID (for assign action)" },
        tagIds: { type: "array", items: { type: "string" }, description: "Tag IDs to assign (for assign action)" },
      },
      required: ["action"],
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth }: ToolHandlerContext) => {
      const schema = z.object({
        action: z.enum(["create", "list", "assign"]),
        name: z.string().optional(),
        objectId: z.string().optional(),
        tagIds: z.array(z.string()).optional(),
      });
      const { action, name, objectId, tagIds } = schema.parse(rawParams);

      if ((action === "create" || action === "assign") && !auth.scopes.includes("write") && !auth.scopes.includes("admin")) {
        throw new Error("Missing required scope: write");
      }

      switch (action) {
        case "list": {
          let tags;
          if (auth.bucketScope) {
            tags = await sql`
              SELECT t.id, t.name, t.slug, COUNT(ot.object_id) as object_count
              FROM tags t
              LEFT JOIN object_tags ot ON ot.tag_id = t.id
              LEFT JOIN objects o ON o.id = ot.object_id
              LEFT JOIN buckets b ON b.id = o.bucket_id
              WHERE t.org_id = ${auth.orgId}
                AND (ot.object_id IS NULL OR b.name = ${auth.bucketScope})
              GROUP BY t.id
              ORDER BY t.name
            `;
          } else {
            tags = await sql`
              SELECT t.id, t.name, t.slug, COUNT(ot.object_id) as object_count
              FROM tags t
              LEFT JOIN object_tags ot ON ot.tag_id = t.id
              WHERE t.org_id = ${auth.orgId}
              GROUP BY t.id
              ORDER BY t.name
            `;
          }
          return { tags };
        }

        case "create": {
          if (!name) throw new Error("Tag name is required for create action");
          const crypto = await import("node:crypto");
          const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
          const id = crypto.randomUUID();

          await sql`INSERT INTO tags (id, org_id, name, slug) VALUES (${id}, ${auth.orgId}, ${name}, ${slug})`;
          return { id, name, slug };
        }

        case "assign": {
          if (!objectId) throw new Error("objectId is required for assign action");
          if (!tagIds || tagIds.length === 0) throw new Error("tagIds is required for assign action");

          const obj = await sql`
            SELECT o.id, b.name as bucket_name FROM objects o
            JOIN buckets b ON b.id = o.bucket_id
            WHERE o.id = ${objectId} AND b.org_id = ${auth.orgId} AND o.deleted_at IS NULL
          `;
          if (obj.length === 0) throw new Error(`Object not found: ${objectId}`);

          if (auth.bucketScope && obj[0]!.bucket_name !== auth.bucketScope) {
            throw new Error("This API key is restricted to a different bucket");
          }

          // Only assign tags that actually belong to this org — parameterized,
          // never string-interpolated (prevents SQL injection + cross-org IDOR).
          const validTags = await sql<{ id: string }[]>`
            SELECT id FROM tags WHERE id = ANY(${tagIds}) AND org_id = ${auth.orgId}
          `;
          await sql`DELETE FROM object_tags WHERE object_id = ${objectId}`;
          if (validTags.length > 0) {
            const rows = validTags.map((t) => ({ object_id: objectId, tag_id: t.id }));
            await sql`INSERT INTO object_tags ${sql(rows, "object_id", "tag_id")}`;
          }

          const assigned = await sql`
            SELECT t.id, t.name, t.slug FROM tags t
            JOIN object_tags ot ON ot.tag_id = t.id
            WHERE ot.object_id = ${objectId}
          `;
          return { objectId, tags: assigned };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  });

  registerTool({
    name: "manage_categories",
    description: "Create, list, or assign categories to media objects. Action: 'create', 'list', or 'assign'.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "assign"], description: "Action to perform" },
        name: { type: "string", description: "Category name (for create action)" },
        parentId: { type: "string", description: "Parent category ID (for create action)" },
        objectId: { type: "string", description: "Object ID (for assign action)" },
        categoryIds: { type: "array", items: { type: "string" }, description: "Category IDs to assign (for assign action)" },
      },
      required: ["action"],
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth }: ToolHandlerContext) => {
      const schema = z.object({
        action: z.enum(["create", "list", "assign"]),
        name: z.string().optional(),
        parentId: z.string().optional(),
        objectId: z.string().optional(),
        categoryIds: z.array(z.string()).optional(),
      });
      const { action, name, parentId, objectId, categoryIds } = schema.parse(rawParams);

      if ((action === "create" || action === "assign") && !auth.scopes.includes("write") && !auth.scopes.includes("admin")) {
        throw new Error("Missing required scope: write");
      }

      switch (action) {
        case "list": {
          let rows;
          if (auth.bucketScope) {
            rows = await sql`
              SELECT c.id, c.name, c.parent_id,
                     COUNT(oc.object_id) as object_count
              FROM categories c
              LEFT JOIN object_categories oc ON oc.category_id = c.id
              LEFT JOIN objects o ON o.id = oc.object_id
              LEFT JOIN buckets b ON b.id = o.bucket_id
              WHERE c.org_id = ${auth.orgId}
                AND (oc.object_id IS NULL OR b.name = ${auth.bucketScope})
              GROUP BY c.id
              ORDER BY c.name
            `;
          } else {
            rows = await sql`
              SELECT c.id, c.name, c.parent_id,
                     COUNT(oc.object_id) as object_count
              FROM categories c
              LEFT JOIN object_categories oc ON oc.category_id = c.id
              WHERE c.org_id = ${auth.orgId}
              GROUP BY c.id
              ORDER BY c.name
            `;
          }

          const catMap = new Map<string, any>();
          const roots: any[] = [];
          for (const row of rows) {
            catMap.set(row.id, { ...row, parentId: row.parent_id, children: [] });
          }
          for (const [, cat] of catMap) {
            if (cat.parentId && catMap.has(cat.parentId)) {
              catMap.get(cat.parentId).children.push(cat);
            } else {
              roots.push(cat);
            }
          }
          return { categories: roots };
        }

        case "create": {
          if (!name) throw new Error("Category name is required for create");
          const crypto = await import("node:crypto");
          const id = crypto.randomUUID();
          await sql`INSERT INTO categories (id, org_id, name, parent_id) VALUES (${id}, ${auth.orgId}, ${name}, ${parentId ?? null})`;
          return { id, name, parentId: parentId ?? null };
        }

        case "assign": {
          if (!objectId) throw new Error("objectId is required for assign");
          if (!categoryIds || categoryIds.length === 0) throw new Error("categoryIds is required");

          const obj = await sql`
            SELECT o.id, b.name as bucket_name FROM objects o
            JOIN buckets b ON b.id = o.bucket_id
            WHERE o.id = ${objectId} AND b.org_id = ${auth.orgId} AND o.deleted_at IS NULL
          `;
          if (obj.length === 0) throw new Error(`Object not found: ${objectId}`);

          if (auth.bucketScope && obj[0]!.bucket_name !== auth.bucketScope) {
            throw new Error("This API key is restricted to a different bucket");
          }

          // Only assign categories that belong to this org — parameterized.
          const validCategories = await sql<{ id: string }[]>`
            SELECT id FROM categories WHERE id = ANY(${categoryIds}) AND org_id = ${auth.orgId}
          `;
          await sql`DELETE FROM object_categories WHERE object_id = ${objectId}`;
          if (validCategories.length > 0) {
            const rows = validCategories.map((c) => ({ object_id: objectId, category_id: c.id }));
            await sql`INSERT INTO object_categories ${sql(rows, "object_id", "category_id")}`;
          }

          const assigned = await sql`
            SELECT c.id, c.name FROM categories c
            JOIN object_categories oc ON oc.category_id = c.id
            WHERE oc.object_id = ${objectId}
          `;
          return { objectId, categories: assigned };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  });
}
