import { z } from "zod";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getS3, refreshS3Client, DERIVED_BUCKET } from "../s3.js";
import { ToolHandlerContext } from "./types.js";
import { createLogger } from "@medialocker/observability";

const logger = createLogger("mcp:objects");

const MAX_KEYS_PER_PURGE = 10000;

export function registerObjectTools(registerTool: (tool: any) => void): void {
  registerTool({
    name: "get_object_url",
    description: "Generate a time-limited presigned download URL for an object.",
    inputSchema: {
      type: "object",
      properties: {
        objectId: { type: "string", description: "Object ID (UUID)" },
        expiresIn: { type: "number", description: "Seconds until URL expires (default 3600, max 604800)" },
      },
      required: ["objectId"],
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth }: ToolHandlerContext) => {
      const schema = z.object({
        objectId: z.string().uuid(),
        expiresIn: z.number().min(1).max(604800).optional(),
      });
      const { objectId, expiresIn } = schema.parse(rawParams);

      const obj = await sql`
        SELECT o.id, o.key, b.name as bucket_name, b.minio_bucket as storage_bucket
        FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        WHERE o.id = ${objectId} AND b.org_id = ${auth.orgId} AND o.deleted_at IS NULL
      `;

      if (obj.length === 0) {
        throw new Error(`Object not found: ${objectId}`);
      }

      // Clamp expiry to [1s, 7d] (P2): a zero/negative lower bound would mint an
      // already-expired (or, under signing quirks, unbounded) URL.
      const exp = Math.min(Math.max(Math.floor(expiresIn ?? 3600), 1), 604800);
      const bucketName = obj[0]!.bucket_name as string;
      const storageBucket = obj[0]!.storage_bucket as string;
      const objectKey = obj[0]!.key as string;

      // Bucket-scoped credentials may only touch their bucket (§5.3).
      if (auth.bucketScope && auth.bucketScope !== bucketName) {
        throw new Error("This API key is restricted to a different bucket");
      }

      // Presign against the backing storage bucket with the master credential.
      const url = await getSignedUrl(
        getS3(),
        new GetObjectCommand({ Bucket: storageBucket, Key: objectKey }),
        { expiresIn: exp },
      );

      return { url, objectId, key: objectKey, expiresIn: exp };
    },
  });

  registerTool({
    name: "upload_object",
    description: "Generate presigned upload instructions for uploading an object to a bucket.",
    inputSchema: {
      type: "object",
      properties: {
        bucketId: { type: "string", description: "Bucket ID (UUID)" },
        key: { type: "string", description: "Object key/path" },
        contentType: { type: "string", description: "MIME type of the object" },
        size: { type: "number", description: "Expected size in bytes" },
      },
      required: ["bucketId", "key"],
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth }: ToolHandlerContext) => {
      const schema = z.object({
        bucketId: z.string().uuid(),
        key: z.string().min(1),
        contentType: z.string().optional(),
        size: z.number().positive().optional(),
        expiresIn: z.number().min(1).max(604800).optional(),
      });
      const { bucketId, key, contentType, size, expiresIn: rawExpiresIn } = schema.parse(rawParams);

      if (!auth.scopes.includes("write") && !auth.scopes.includes("admin")) {
        throw new Error("Missing required scope: write");
      }

      const bucket = await sql`
        SELECT id, name, minio_bucket FROM buckets
        WHERE id = ${bucketId} AND org_id = ${auth.orgId} AND deleted_at IS NULL
      `;

      if (bucket.length === 0) {
        throw new Error(`Bucket not found: ${bucketId}`);
      }

      // Pre-flight quota check (§4.8): reject before handing out an upload URL if
      // the declared size clearly won't fit, so the caller fails fast instead of
      // after streaming bytes. The authoritative reservation still happens at the
      // gateway PUT (which meters actual bytes), so this is a check, not a
      // reservation — no double-counting.
      if (typeof size === "number" && size > 0) {
        const cap = await sql<{ used_bytes: string; allocated_bytes: string }[]>`
          SELECT used_bytes, allocated_bytes FROM capacity WHERE org_id = ${auth.orgId}
        `;
        if (cap.length > 0) {
          const used = BigInt(cap[0]!.used_bytes);
          const allocated = BigInt(cap[0]!.allocated_bytes);
          if (used + BigInt(Math.ceil(size)) > allocated) {
            throw new Error(
              `InsufficientStorage: ${size} bytes would exceed allocated capacity (${allocated - used} bytes free). Add capacity or free space first.`,
            );
          }
        }
      }

      const bucketName = bucket[0]!.name as string;
      const storageBucket = bucket[0]!.minio_bucket as string;

      // Bucket-scoped credentials may only upload to their bucket (§5.3).
      if (auth.bucketScope && auth.bucketScope !== bucketName) {
        throw new Error("This API key is restricted to a different bucket");
      }

      const expiresIn = Math.min(Math.max(Math.floor(rawExpiresIn ?? 3600), 1), 604800);

      // Presign against the backing storage bucket with the master credential.
      const presignedUrl = await getSignedUrl(
        getS3(),
        new PutObjectCommand({ Bucket: storageBucket, Key: key }),
        { expiresIn },
      );

      return {
        uploadUrl: presignedUrl,
        method: "PUT",
        key,
        bucketName,
        bucketId,
        expiresIn,
        headers: contentType ? { "Content-Type": contentType } : {},
        expectedSize: size,
      };
    },
  });

  registerTool({
    name: "list_objects",
    description: "List objects in a bucket with optional prefix and pagination.",
    inputSchema: {
      type: "object",
      properties: {
        bucketId: { type: "string", description: "Bucket ID (UUID)" },
        prefix: { type: "string", description: "Key prefix filter" },
        limit: { type: "number", description: "Max results (default 50)" },
        offset: { type: "number", description: "Pagination offset (default 0)" },
      },
      required: ["bucketId"],
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth }: ToolHandlerContext) => {
      const schema = z.object({
        bucketId: z.string().uuid(),
        prefix: z.string().optional(),
        limit: z.number().min(1).max(100).optional(),
        offset: z.number().min(0).optional(),
      });
      const { bucketId, prefix, limit, offset } = schema.parse(rawParams);

      const bucket = await sql`SELECT id, name FROM buckets WHERE id = ${bucketId} AND org_id = ${auth.orgId} AND deleted_at IS NULL`;
      if (bucket.length === 0) {
        throw new Error(`Bucket not found: ${bucketId}`);
      }

      if (auth.bucketScope && bucket[0]!.name !== auth.bucketScope) {
        throw new Error("This API key is restricted to a different bucket");
      }

      let query = sql`SELECT id, key, size, content_type, created_at FROM objects WHERE bucket_id = ${bucketId} AND deleted_at IS NULL`;
      if (prefix) {
        const escaped = prefix.replace(/([\\%_])/g, "\\$1");
        query = sql`${query} AND key LIKE ${escaped + "%"} ESCAPE '\\'`;
      }
      query = sql`${query} ORDER BY key ASC LIMIT ${Math.min(limit ?? 50, 100)} OFFSET ${offset ?? 0}`;

      const items = await query;
      return { bucketId, items };
    },
  });

  registerTool({
    name: "delete_object",
    description: "DESTRUCTIVE: Soft-delete an object. Requires delete scope.",
    inputSchema: {
      type: "object",
      properties: {
        objectId: { type: "string", description: "Object ID (UUID)" },
      },
      required: ["objectId"],
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth }: ToolHandlerContext) => {
      const schema = z.object({ objectId: z.string().uuid() });
      const { objectId } = schema.parse(rawParams);

      if (!auth.scopes.includes("delete") && !auth.scopes.includes("admin")) {
        throw new Error("Missing required scope: delete");
      }

      const bucketScopeCond = auth.bucketScope
        ? sql`AND b.name = ${auth.bucketScope}`
        : sql``;

      // Soft-delete and release the reserved capacity atomically (emit a negative
      // stored delta), matching the gateway + control-plane delete behavior so
      // used_bytes never drifts upward.
      const deleted = await sql.begin(async (tx) => {
        const rows = await tx<{ size: string }[]>`
          SELECT o.size FROM objects o
          JOIN buckets b ON b.id = o.bucket_id
          WHERE o.id = ${objectId} AND b.org_id = ${auth.orgId} AND o.deleted_at IS NULL ${bucketScopeCond}
        `;
        if (rows.length === 0) return false;
        const size = Number(rows[0]!.size);

        await tx`UPDATE objects SET deleted_at = now() WHERE id = ${objectId}`;
        if (size > 0) {
          await tx`UPDATE capacity SET used_bytes = GREATEST(0, used_bytes - ${size}) WHERE org_id = ${auth.orgId}`;
          await tx`INSERT INTO usage_events (org_id, type, bytes, ts) VALUES (${auth.orgId}, 'stored_delta', ${-size}, now())`;
        }
        return true;
      });

      if (!deleted) {
        throw new Error(`Object not found: ${objectId}`);
      }

      void sql`INSERT INTO audit_log (org_id, actor, action, target, ip, ts) VALUES (${auth.orgId}, ${auth.userId ?? "mcp"}, 'delete_object', ${objectId}, null, now())`.catch(() => {});

      return { status: "deleted", objectId };
    },
  });

  registerTool({
    name: "purge",
    description: "DESTRUCTIVE: Permanently hard-delete all soft-deleted objects in the organization. Requires delete scope.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: { type: "string", description: "Type 'DELETE' to confirm permanent purge" },
      },
      required: ["confirm"],
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth }: ToolHandlerContext) => {
      const schema = z.object({ confirm: z.literal("DELETE") });
      const { confirm } = schema.parse(rawParams);

      if (!auth.scopes.includes("delete") && !auth.scopes.includes("admin")) {
        throw new Error("Missing required scope: delete");
      }

      if (auth.bucketScope) {
        const bkt = await sql`SELECT id FROM buckets WHERE org_id = ${auth.orgId} AND name = ${auth.bucketScope} AND deleted_at IS NULL`;
        if (bkt.length === 0) {
          throw new Error("This API key is restricted to a different bucket");
        }
      }

      const bucketScopeClause = auth.bucketScope
        ? sql`AND name = ${auth.bucketScope}`
        : sql``;

      const countResult = await sql`SELECT COUNT(*)::int AS count FROM objects
        WHERE deleted_at IS NOT NULL
          AND bucket_id IN (SELECT id FROM buckets WHERE org_id = ${auth.orgId} ${bucketScopeClause})`;
      const count = parseInt(countResult[0]?.count ?? "0", 10);

      if (count === 0) {
        return { purged: 0, message: "No soft-deleted objects to purge" };
      }

      if (count > MAX_KEYS_PER_PURGE) {
        throw new Error(
          `Too many objects to purge (${count} > ${MAX_KEYS_PER_PURGE}). ` +
          `Reduce scope (e.g. by bucket or prefix) or split into multiple purges.`
        );
      }

      await refreshS3Client();
      const s3 = getS3();

      const { rows, derivKeys } = await sql.begin(async (tx) => {
        const derivBucketScope = auth.bucketScope
          ? tx`AND b.name = ${auth.bucketScope}`
          : tx``;

        const derivKeys = await tx<{ minio_key: string }[]>`
          SELECT d.minio_key FROM derivatives d
          JOIN objects o ON o.id = d.object_id
          JOIN buckets b ON b.id = o.bucket_id
          WHERE o.deleted_at IS NOT NULL AND b.org_id = ${auth.orgId} ${derivBucketScope}
        `;

        const rows = await tx<{ key: string; minio_bucket: string }[]>`
          DELETE FROM objects o
          USING buckets b
          WHERE o.bucket_id = b.id AND o.deleted_at IS NOT NULL AND b.org_id = ${auth.orgId} ${derivBucketScope}
          RETURNING o.key, b.minio_bucket
        `;

        return { rows, derivKeys };
      });

      const minioErrors: string[] = [];

      const bucketGroups = new Map<string, string[]>();
      for (const row of rows) {
        const keys = bucketGroups.get(row.minio_bucket) ?? [];
        keys.push(row.key);
        bucketGroups.set(row.minio_bucket, keys);
      }
      if (derivKeys.length > 0) {
        bucketGroups.set(DERIVED_BUCKET, derivKeys.map((d) => d.minio_key));
      }

      for (const [bucket, keys] of bucketGroups) {
        for (let i = 0; i < keys.length; i += 1000) {
          const chunk = keys.slice(i, i + 1000);
          try {
            await s3.send(new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: chunk.map((Key) => ({ Key })) },
            }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error({ err, bucket, keyCount: chunk.length }, "MinIO purge deletion failed");
            minioErrors.push(`${bucket}: ${msg}`);
          }
        }
      }

      if (minioErrors.length > 0) {
        logger.error({ minioErrors, orgId: auth.orgId, deletedCount: rows.length }, "purge completed with MinIO cleanup failures — manual/scheduled retry required");
      }

      void sql`INSERT INTO audit_log (org_id, actor, action, target, ip, ts) VALUES (${auth.orgId}, ${auth.userId ?? "mcp"}, 'purge', ${rows.length + ''}||' objects', null, now())`.catch(() => {});

      return { purged: rows.length, message: `Permanently deleted ${rows.length} objects` };
    },
  });

  registerTool({
    name: "get_object_metadata",
    description: "Get metadata and media asset info for an object.",
    inputSchema: {
      type: "object",
      properties: {
        objectId: { type: "string", description: "Object ID (UUID)" },
      },
      required: ["objectId"],
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth }: ToolHandlerContext) => {
      const schema = z.object({ objectId: z.string().uuid() });
      const { objectId } = schema.parse(rawParams);

      const rows = await sql`
        SELECT o.*, b.name as bucket_name, ma.kind, ma.width, ma.height, ma.duration_ms, ma.codec, ma.frame_rate, ma.has_audio
        FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        LEFT JOIN media_assets ma ON ma.object_id = o.id
        WHERE o.id = ${objectId} AND b.org_id = ${auth.orgId} AND o.deleted_at IS NULL
      `;

      if (rows.length === 0) {
        throw new Error(`Object not found: ${objectId}`);
      }

      if (auth.bucketScope && rows[0]!.bucket_name !== auth.bucketScope) {
        throw new Error("This API key is restricted to a different bucket");
      }

      const metadata = await sql`SELECT key, value FROM object_user_metadata WHERE object_id = ${objectId}`;
      const tags = await sql`SELECT t.name, t.slug FROM tags t JOIN object_tags ot ON ot.tag_id = t.id WHERE ot.object_id = ${objectId}`;

      return {
        ...rows[0],
        userMetadata: Object.fromEntries(metadata.map((m: any) => [m.key, m.value])),
        tags: tags.map((t: any) => t.name),
      };
    },
  });
}
