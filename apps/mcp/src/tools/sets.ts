import { z } from "zod";
import { getVariantQueue } from "../queues.js";
import { ToolHandlerContext } from "./types.js";

export function registerSetTools(registerTool: (tool: any) => void): void {
  registerTool({
    name: "create_set",
    description: "Create a new set for grouping variant renditions of media.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Set name" },
        baseObjectId: { type: "string", description: "Base object ID (optional)" },
      },
      required: ["name"],
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth }: ToolHandlerContext) => {
      const crypto = await import("node:crypto");
      const schema = z.object({
        name: z.string().min(1),
        baseObjectId: z.string().uuid().optional(),
      });
      const { name, baseObjectId } = schema.parse(rawParams);

      if (!auth.scopes.includes("write") && !auth.scopes.includes("admin")) {
        throw new Error("Missing required scope: write");
      }

      // Tenant isolation: a base object reference must belong to THIS org. Without
      // this check a caller could pin their set to another tenant's object id. (3.4)
      if (baseObjectId) {
        const owns = await sql`
          SELECT o.id, b.name as bucket_name FROM objects o
          JOIN buckets b ON b.id = o.bucket_id
          WHERE o.id = ${baseObjectId} AND b.org_id = ${auth.orgId} AND o.deleted_at IS NULL
          LIMIT 1
        `;
        if (owns.length === 0) {
          throw new Error(`Base object not found: ${baseObjectId}`);
        }
        if (auth.bucketScope && owns[0]!.bucket_name !== auth.bucketScope) {
          throw new Error("This API key is restricted to a different bucket");
        }
      }

      const id = crypto.randomUUID();
      await sql`
        INSERT INTO sets (id, org_id, name, base_object_id)
        VALUES (${id}, ${auth.orgId}, ${name}, ${baseObjectId ?? null})
      `;

      return { id, name, baseObjectId: baseObjectId ?? null };
    },
  });

  registerTool({
    name: "add_variant",
    description: "Add an object variant to a set with aspect ratio and size.",
    inputSchema: {
      type: "object",
      properties: {
        setId: { type: "string", description: "Set ID (UUID)" },
        objectId: { type: "string", description: "Object ID to add (UUID)" },
        aspectRatio: { type: "string", description: "Aspect ratio (e.g. 16:9, 1:1, 9:16)" },
        width: { type: "number", description: "Target width in pixels" },
        height: { type: "number", description: "Target height in pixels" },
        role: { type: "string", description: "Role label (e.g. 'thumbnail', 'social', 'hero')" },
      },
      required: ["setId", "objectId"],
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth }: ToolHandlerContext) => {
      const crypto = await import("node:crypto");
      const schema = z.object({
        setId: z.string().uuid(),
        objectId: z.string().uuid(),
        aspectRatio: z.string().optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        role: z.string().optional(),
      });
      const { setId, objectId, aspectRatio, width, height, role } = schema.parse(rawParams);

      if (!auth.scopes.includes("write") && !auth.scopes.includes("admin")) {
        throw new Error("Missing required scope: write");
      }

      const set = await sql`SELECT id FROM sets WHERE id = ${setId} AND org_id = ${auth.orgId}`;
      if (set.length === 0) throw new Error(`Set not found: ${setId}`);

      const obj = await sql`
        SELECT o.id, b.name as bucket_name FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        WHERE o.id = ${objectId} AND b.org_id = ${auth.orgId} AND o.deleted_at IS NULL
      `;
      if (obj.length === 0) throw new Error(`Object not found: ${objectId}`);

      if (auth.bucketScope && obj[0]!.bucket_name !== auth.bucketScope) {
        throw new Error("This API key is restricted to a different bucket");
      }

      const itemId = crypto.randomUUID();
      await sql`
        INSERT INTO set_items (id, set_id, object_id, aspect_ratio, width, height, role)
        VALUES (${itemId}, ${setId}, ${objectId}, ${aspectRatio ?? null}, ${width ?? null}, ${height ?? null}, ${role ?? null})
      `;

      return { id: itemId, setId, objectId, aspectRatio, width, height, role };
    },
  });

  registerTool({
    name: "list_sets",
    description: "List all sets in the organization.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth }: ToolHandlerContext) => {
      z.object({}).parse(rawParams);
      const rows = await sql`
        SELECT s.id, s.name, s.base_object_id, s.created_at,
               COUNT(si.id) as item_count
        FROM sets s
        LEFT JOIN set_items si ON si.set_id = s.id
        WHERE s.org_id = ${auth.orgId}
        GROUP BY s.id
        ORDER BY s.created_at DESC
      `;

      return { sets: rows };
    },
  });

  registerTool({
    name: "generate_variants",
    description: "Trigger variant generation for all items in a set. Enqueues media processing jobs.",
    inputSchema: {
      type: "object",
      properties: {
        setId: { type: "string", description: "Set ID (UUID)" },
      },
      required: ["setId"],
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth, config }: ToolHandlerContext) => {
      const schema = z.object({ setId: z.string().uuid() });
      const { setId } = schema.parse(rawParams);

      if (!auth.scopes.includes("write") && !auth.scopes.includes("admin")) {
        throw new Error("Missing required scope: write");
      }

      const set = await sql`SELECT id, name FROM sets WHERE id = ${setId} AND org_id = ${auth.orgId}`;
      if (set.length === 0) throw new Error(`Set not found: ${setId}`);

      // Pull each set item with everything the worker's variant processor needs:
      // the source object's MinIO location + kind, and the item's target dims.
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
         WHERE si.set_id = ${setId} AND o.deleted_at IS NULL
      `;

      const queue = getVariantQueue(config.REDIS_URL);
      const enqueued: string[] = [];
      const skipped: string[] = [];

      for (const it of items) {
        // Need explicit target dimensions to render a variant.
        if (!it.width || !it.height) {
          skipped.push(it.set_item_id);
          continue;
        }
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
          // Deterministic jobId → re-running is idempotent (no duplicate jobs).
          { jobId: `variant-${it.set_item_id}` },
        );
        enqueued.push(it.set_item_id);
      }

      return {
        status: "enqueued",
        setId,
        message: `Variant generation enqueued for ${enqueued.length}/${items.length} items in set "${set[0]!.name}"`,
        enqueuedCount: enqueued.length,
        skippedCount: skipped.length,
        ...(skipped.length > 0 ? { skippedNote: "Items without target width/height were skipped — set dimensions via add_variant." } : {}),
      };
    },
  });
}
