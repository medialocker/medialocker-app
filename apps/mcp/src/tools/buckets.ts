import { z } from "zod";
import { validateBucketName, buildBucketName } from "@medialocker/core";
import { CreateBucketCommand, DeleteObjectCommand, DeleteBucketCommand, PutPublicAccessBlockCommand } from "@aws-sdk/client-s3";
import { getS3, refreshS3Client } from "../s3.js";
import { ToolHandlerContext } from "./types.js";

export function registerBucketTools(registerTool: (tool: any) => void): void {
  registerTool({
    name: "list_buckets",
    description: "List all S3 buckets in the organization with usage summaries.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth }: ToolHandlerContext) => {
      z.object({}).parse(rawParams);
      const bucketScopeCond = auth.bucketScope
        ? sql`AND b.name = ${auth.bucketScope}`
        : sql``;
      const buckets = await sql`
        SELECT b.id, b.name, b.minio_bucket, b.versioning_enabled, b.created_at,
               COUNT(o.id) as object_count,
               COALESCE(SUM(o.size), 0) as total_size
        FROM buckets b
        LEFT JOIN objects o ON o.bucket_id = b.id AND o.deleted_at IS NULL
        WHERE b.org_id = ${auth.orgId} AND b.deleted_at IS NULL ${bucketScopeCond}
        GROUP BY b.id
        ORDER BY b.created_at DESC
      `;
      return { buckets };
    },
  });

  registerTool({
    name: "create_bucket",
    description: "Create a new S3 bucket for the organization.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Bucket name (3-63 chars, lowercase, DNS-safe)" },
      },
      required: ["name"],
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth, config }: ToolHandlerContext) => {
      const crypto = await import("node:crypto");
      const schema = z.object({ name: z.string().min(3).max(63) });
      const { name } = schema.parse(rawParams);

      if (!auth.scopes.includes("write") && !auth.scopes.includes("admin")) {
        throw new Error("Missing required scope: write");
      }

      // A bucket-scoped credential is confined to one existing bucket and must
      // not be able to create new ones (§5.3).
      if (auth.bucketScope) {
        throw new Error("This API key is restricted to a single bucket and cannot create buckets");
      }

      // Enforce S3/DNS-safe naming before persisting (the gateway routes buckets
      // as `<name>.s3.<domain>`, so an invalid name is unroutable).
      const check = validateBucketName(name);
      if (!check.valid) {
        throw new Error(`Invalid bucket name: ${check.reason}`);
      }

      // Bucket names are GLOBALLY unique (buckets_name_unique index) because the
      // gateway routes them as `<name>.s3.<domain>` — so the pre-check must be
      // global, matching the constraint, not org-scoped.
      const existing = await sql`SELECT id FROM buckets WHERE name = ${name} AND deleted_at IS NULL`;
      if (existing.length > 0) {
        throw new Error(`Bucket "${name}" already exists`);
      }

      const bucketId = crypto.randomUUID();
      // Canonical, length-bounded backing storage name shared with the API (3.2).
      const minioBucket = buildBucketName(auth.orgId, name);

      // Create the backing storage bucket BEFORE the DB row (§5.6) so we never
      // commit a bucket record that points at storage which doesn't exist (the
      // gateway would otherwise fail every PutObject to it). Tolerate a bucket
      // that already exists; rethrow anything else so we don't persist a row for
      // a bucket we failed to provision.
      try {
        // §5: pick up a rotated storage secret before the storage call.
        await refreshS3Client();
        await getS3().send(new CreateBucketCommand({ Bucket: minioBucket }));
      } catch (err) {
        const errName = (err as { name?: string })?.name;
        if (errName !== "BucketAlreadyOwnedByYou" && errName !== "BucketAlreadyExists") {
          throw err;
        }
      }

      // v1 buckets are private (presigned access only). Best-effort: block all
      // public access; tolerate backends that don't support the call.
      try {
        await getS3().send(new PutPublicAccessBlockCommand({
          Bucket: minioBucket,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        }));
      } catch { /* best-effort */ }

      await sql`
        INSERT INTO buckets (id, org_id, name, minio_bucket, created_at)
        VALUES (${bucketId}, ${auth.orgId}, ${name}, ${minioBucket}, now())
      `;

      return {
        id: bucketId,
        name,
        endpoint: `${name}.s3.${config.PUBLIC_BASE_DOMAIN}`,
      };
    },
  });

  registerTool({
    name: "get_bucket_info",
    description: "Get detailed information about a bucket including usage statistics.",
    inputSchema: {
      type: "object",
      properties: {
        bucketId: { type: "string", description: "Bucket ID (UUID)" },
      },
      required: ["bucketId"],
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth }: ToolHandlerContext) => {
      const schema = z.object({ bucketId: z.string().uuid() });
      const { bucketId } = schema.parse(rawParams);

      const rows = await sql`
        SELECT b.id, b.name, b.minio_bucket, b.versioning_enabled, b.created_at,
               COUNT(o.id) as object_count,
               COALESCE(SUM(o.size), 0) as total_size
        FROM buckets b
        LEFT JOIN objects o ON o.bucket_id = b.id AND o.deleted_at IS NULL
        WHERE b.id = ${bucketId} AND b.org_id = ${auth.orgId} AND b.deleted_at IS NULL
        GROUP BY b.id
      `;

      if (rows.length === 0) {
        throw new Error(`Bucket not found: ${bucketId}`);
      }

      if (auth.bucketScope && rows[0]!.name !== auth.bucketScope) {
        throw new Error("This API key is restricted to a different bucket");
      }

      return rows[0];
    },
  });

  registerTool({
    name: "delete_bucket",
    description: "DESTRUCTIVE: Delete a bucket. Bucket must be empty. Requires delete scope.",
    inputSchema: {
      type: "object",
      properties: {
        bucketId: { type: "string", description: "Bucket ID (UUID)" },
      },
      required: ["bucketId"],
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth }: ToolHandlerContext) => {
      const schema = z.object({ bucketId: z.string().uuid() });
      const { bucketId } = schema.parse(rawParams);

      if (!auth.scopes.includes("delete") && !auth.scopes.includes("admin")) {
        throw new Error("Missing required scope: delete");
      }

      if (auth.bucketScope) {
        const bkt = await sql`SELECT name FROM buckets WHERE id = ${bucketId} AND org_id = ${auth.orgId} AND deleted_at IS NULL`;
        if (bkt.length === 0 || bkt[0]!.name !== auth.bucketScope) {
          throw new Error("This API key is restricted to a different bucket");
        }
      }

      const objCount = await sql`SELECT COUNT(*) as count FROM objects WHERE bucket_id = ${bucketId} AND deleted_at IS NULL`;
      if (parseInt(objCount[0]!.count, 10) > 0) {
        throw new Error("Bucket must be empty before deletion");
      }

      const result = await sql<{ minio_bucket: string }[]>`
        UPDATE buckets SET deleted_at = now()
        WHERE id = ${bucketId} AND org_id = ${auth.orgId} AND deleted_at IS NULL
        RETURNING minio_bucket
      `;

      if (result.length === 0) {
        throw new Error("Bucket not found");
      }

      // Delete the (verified-empty) backing MinIO bucket so we don't leak empty
      // buckets in storage. Best-effort: ops/reconcile can sweep a failure. (M7)
      try {
        await refreshS3Client();
        await getS3().send(new DeleteBucketCommand({ Bucket: result[0]!.minio_bucket }));
      } catch { /* best-effort */ }

      void sql`INSERT INTO audit_log (org_id, actor, action, target, ip, ts) VALUES (${auth.orgId}, ${auth.userId ?? "mcp"}, 'delete_bucket', ${bucketId}, null, now())`.catch(() => {});

      return { status: "deleted", bucketId };
    },
  });
}
