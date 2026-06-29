import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutPublicAccessBlockCommand,
} from "@aws-sdk/client-s3";
import { getConfig } from "@medialocker/config";
import { validateBucketName, buildBucketName } from "@medialocker/core";
import { getS3, refreshS3Client } from "../lib/s3.js";
import { validate } from "../middleware/validation.js";
import { requireScope } from "../middleware/auth.js";
import { createLogger } from "@medialocker/observability";

const logger = createLogger("api:routes:buckets");

// Basic shape guard; the authoritative rule (no dots, IP/xn-- rejection, length)
// is @medialocker/core.validateBucketName, applied in the handler (2.3).
const createBucketSchema = z.object({
  name: z.string().min(3).max(63),
});

export async function bucketRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/buckets",
    { preHandler: [validate({ body: createBucketSchema }), requireScope("write")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const crypto = await import("node:crypto");
      const { name } = request.body as z.infer<typeof createBucketSchema>;

      // Authoritative name validation (rejects dots / IP-form / xn-- / bad length).
      const check = validateBucketName(name);
      if (!check.valid) {
        return reply.status(400).send({ error: { code: "InvalidBucketName", message: check.reason ?? "Invalid bucket name" } });
      }

      // Bucket names are GLOBALLY unique (buckets_name_unique index).
      const existing = await sql<{ id: string }[]>`
        SELECT id FROM buckets WHERE name = ${name} AND deleted_at IS NULL
      `;
      if (existing.length > 0) {
        return reply.status(409).send({ error: { code: "Conflict", message: "Bucket name already exists" } });
      }

      // C02: check for soft-deleted buckets with the same name. When a bucket was
      // previously soft-deleted, reuse of the same logical name must map to a FRESH
      // MinIO bucket (so old objects don't reappear). Append a nonce suffix.
      const softDeleted = await sql<{ id: string }[]>`
        SELECT id FROM buckets WHERE name = ${name} AND deleted_at IS NOT NULL
      `;
      const hasSoftDeleted = softDeleted.length > 0;

      const bucketId = crypto.randomUUID();
      // Canonical, length-bounded storage name shared with MCP + billing (2.3/3.2).
      const baseStorageBucket = buildBucketName(auth.orgId, name);
      const minioBucket = hasSoftDeleted
        ? buildBucketName(auth.orgId, `${name}-${Date.now().toString(36)}`)
        : baseStorageBucket;

      // C01: INSERT into buckets FIRST — the loser of a concurrent create
      // never reaches MinIO, so it can never delete the winner's bucket.
      try {
        await sql`
          INSERT INTO buckets (id, org_id, name, minio_bucket, created_at)
          VALUES (${bucketId}, ${auth.orgId}, ${name}, ${minioBucket}, now())
        `;
      } catch (dbErr) {
        const errCode = (dbErr as { code?: string })?.code;
        if (errCode === "23505") {
          return reply.status(409).send({ error: { code: "Conflict", message: "Bucket name already exists" } });
        }
        throw dbErr;
      }

      // C01: THEN provision the backing Hetzner bucket. Tolerate an already-existing
      // bucket; on any other error roll back the DB row (DELETE, not DeleteBucket).
      try {
        await refreshS3Client();
        await getS3().send(new CreateBucketCommand({ Bucket: minioBucket }));
      } catch (err) {
        const errName = (err as { name?: string })?.name;
        if (errName !== "BucketAlreadyOwnedByYou" && errName !== "BucketAlreadyExists") {
          logger.error({ err, minioBucket, orgId: auth.orgId }, "Failed to provision storage bucket");
          try { await sql`DELETE FROM buckets WHERE id = ${bucketId}`; } catch { /* best-effort */ }
          return reply.status(502).send({ error: { code: "StorageError", message: "Failed to provision bucket storage" } });
        }
      }

      // v1 is 100% private + presigned (§2). Keep the bucket private — block all
      // public access. Presigned GETs are SigV4-signed (authenticated as the
      // master cred), so this never breaks tenant delivery. Best-effort: a policy
      // failure must not fail an otherwise-provisioned bucket.
      try {
        await getS3().send(
          new PutPublicAccessBlockCommand({
            Bucket: minioBucket,
            PublicAccessBlockConfiguration: {
              BlockPublicAcls: true,
              IgnorePublicAcls: true,
              BlockPublicPolicy: true,
              RestrictPublicBuckets: true,
            },
          }),
        );
      } catch (err) {
        logger.warn({ err, minioBucket, orgId: auth.orgId }, "Failed to enforce private access block (bucket private by default)");
      }
      await sql`
        INSERT INTO audit_log (org_id, actor, action, target, ip)
        VALUES (${auth.orgId}, ${auth.userId ?? auth.apiKeyId ?? "system"}, 'bucket.create', ${bucketId}, ${request.ip})
      `;

      logger.info({ bucketId, name, orgId: auth.orgId }, "Bucket created");

      reply.status(201).send({
        id: bucketId,
        name,
        minioBucket,
        // Tenants never address the bucket directly — they use presigned URLs.
        // Informational only: the backing storage endpoint.
        endpoint: getConfig().HETZNER_S3_ENDPOINT,
      });
    },
  );

  app.get(
    "/buckets",
    { preHandler: [validate({}), requireScope("read")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const buckets = await sql<{
        id: string;
        name: string;
        minio_bucket: string;
        versioning_enabled: boolean;
        created_at: string;
        object_count: string;
        total_size: string;
      }[]>`
        SELECT
          b.id, b.name, b.minio_bucket, b.versioning_enabled, b.created_at,
          COUNT(o.id)::text as object_count,
          COALESCE(SUM(o.size), 0)::text as total_size
        FROM buckets b
        LEFT JOIN objects o ON o.bucket_id = b.id AND o.deleted_at IS NULL
        WHERE b.org_id = ${auth.orgId} AND b.deleted_at IS NULL
        GROUP BY b.id
        ORDER BY b.created_at DESC
      `;
      return {
        buckets: buckets.map((b) => ({
          ...b,
          objectCount: parseInt(b.object_count, 10),
          totalSize: BigInt(b.total_size).toString(),
        })),
      };
    },
  );

  app.get(
    "/buckets/:id",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }) }), requireScope("read")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id } = (request as any).validatedParams as { id: string };

      const rows = await sql<{
        id: string;
        name: string;
        minio_bucket: string;
        versioning_enabled: boolean;
        created_at: string;
        object_count: string;
        total_size: string;
      }[]>`
        SELECT
          b.id, b.name, b.minio_bucket, b.versioning_enabled, b.created_at,
          COUNT(o.id)::text as object_count,
          COALESCE(SUM(o.size), 0)::text as total_size
        FROM buckets b
        LEFT JOIN objects o ON o.bucket_id = b.id AND o.deleted_at IS NULL
        WHERE b.id = ${id} AND b.org_id = ${auth.orgId} AND b.deleted_at IS NULL
        GROUP BY b.id
      `;

      if (rows.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Bucket not found" } });
      }

      const bucket = rows[0]!;
      return {
        ...bucket,
        objectCount: parseInt(bucket.object_count, 10),
        totalSize: BigInt(bucket.total_size).toString(),
      };
    },
  );

  app.delete(
    "/buckets/:id",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }) }), requireScope("delete")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id } = (request as any).validatedParams as { id: string };

      const objCount = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM objects WHERE bucket_id = ${id} AND deleted_at IS NULL
      `;

      if (parseInt(objCount[0]!.count, 10) > 0) {
        return reply.status(409).send({
          error: { code: "BucketNotEmpty", message: "Bucket must be empty before deletion. Delete all objects first." },
        });
      }

      // Capture the backing MinIO bucket name BEFORE the soft-delete so we can
      // clean up its storage afterwards (P2.16).
      const target = await sql<{ minio_bucket: string }[]>`
        SELECT minio_bucket FROM buckets
        WHERE id = ${id} AND org_id = ${auth.orgId} AND deleted_at IS NULL
      `;

      const result = await sql`
        UPDATE buckets SET deleted_at = now()
        WHERE id = ${id} AND org_id = ${auth.orgId} AND deleted_at IS NULL
      `;

      if (result.count === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Bucket not found" } });
      }

      await sql`
        INSERT INTO audit_log (org_id, actor, action, target, ip)
        VALUES (${auth.orgId}, ${auth.userId ?? auth.apiKeyId ?? "system"}, 'bucket.delete', ${id}, ${request.ip})
      `;

      // P2.16 — BUCKET SOFT-DELETE MINIO CLEANUP CONTRACT:
      // There is no dedicated async storage-reconcile queue in this deployment,
      // so the soft-delete path must release the backing MinIO bucket itself —
      // otherwise the empty (or tombstone-only) MinIO bucket leaks forever and a
      // future create that reuses the same logical name is forced onto a nonce
      // suffix (see C02 above) accumulating dead buckets.
      // The logical bucket is already verified empty of ACTIVE objects above, but
      // soft-deleted object bytes / multipart debris may remain — so we drain any
      // residual keys first, then drop the bucket. All of this is best-effort: the
      // soft-deleted DB row is the durable record, so a MinIO error never fails
      // the API call (and the row remains available for a manual/future reconcile).
      const minioBucket = target[0]?.minio_bucket;
      if (minioBucket) {
        try {
          await refreshS3Client();
          const s3 = getS3();
          // Drain residual keys (paginated) before deleting the bucket — MinIO
          // refuses to delete a non-empty bucket.
          let continuationToken: string | undefined;
          do {
            const listed = await s3.send(
              new ListObjectsV2Command({ Bucket: minioBucket, ContinuationToken: continuationToken }),
            );
            for (const obj of listed.Contents ?? []) {
              if (!obj.Key) continue;
              try {
                await s3.send(new DeleteObjectCommand({ Bucket: minioBucket, Key: obj.Key }));
              } catch { /* best-effort */ }
            }
            continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
          } while (continuationToken);

          await s3.send(new DeleteBucketCommand({ Bucket: minioBucket }));
        } catch (err) {
          // Leave the soft-deleted row as the reconcile source of truth.
          logger.warn({ err, minioBucket, bucketId: id, orgId: auth.orgId }, "Best-effort MinIO bucket cleanup failed on soft-delete");
        }
      }

      logger.info({ bucketId: id, orgId: auth.orgId }, "Bucket deleted");
      return { status: "deleted" };
    },
  );
}
