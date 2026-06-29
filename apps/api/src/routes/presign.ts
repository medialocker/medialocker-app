import { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { reconcileCapacity, acquireOrgLock } from "@medialocker/core";
import { autoAddCapacity } from "@medialocker/billing";
import { createLogger } from "@medialocker/observability";
import { validate } from "../middleware/validation.js";
import { requireScope } from "../middleware/auth.js";
import { getS3, refreshS3Client } from "../lib/s3.js";
import { getProbeQueue } from "../lib/queues.js";
import {
  presignGet,
  presignPut,
  presignCreateMultipart,
  presignUploadPart,
  presignCompleteMultipart,
  buildTaggingValue,
} from "../lib/presign.js";

const logger = createLogger("api:routes:presign");

// §10.8 — flat tag labels applied atomically with the upload via x-amz-tagging.
const tagsField = z.array(z.string().min(1).max(128)).max(10).optional();

const uploadSchema = z.object({
  bucketId: z.string().uuid(),
  key: z.string().min(1).max(1024),
  contentType: z.string().optional(),
  size: z.number().int().positive().optional(),
  tags: tagsField,
});

const createMultipartSchema = z.object({
  bucketId: z.string().uuid(),
  key: z.string().min(1).max(1024),
  contentType: z.string().optional(),
  // Client-declared total size for the optimistic reserve at create (§8.2).
  // Multipart has no in-flight size cap, so this is best-effort; the
  // authoritative true-up still happens at confirm via HEAD.
  size: z.number().int().positive().optional(),
});

const uploadPartSchema = z.object({
  bucketId: z.string().uuid(),
  key: z.string().min(1),
  uploadId: z.string().min(1),
  partNumber: z.number().int().min(1).max(10000),
  contentType: z.string().optional(),
});

const completeUploadSchema = z.object({
  bucketId: z.string().uuid(),
  key: z.string().min(1),
  uploadId: z.string().min(1),
  tags: tagsField,
});

const confirmSchema = z.object({
  bucketId: z.string().uuid(),
  key: z.string().min(1).max(1024),
});

const downloadSchema = z.object({
  objectId: z.string().uuid(),
  expiresIn: z.coerce.number().int().min(60).max(604800).default(3600),
});

const PRESIGN_TTL = 3600;

/**
 * Resolve the backing storage bucket for an org-owned logical bucket. RETURNS
 * null if the bucket isn't owned by the caller's org — this is THE org-ownership
 * authorization gate (§9): every presign path must confirm ownership before we
 * sign anything with the master credential.
 */
async function resolveOwnedBucket(
  sql: any,
  bucketId: string,
  orgId: string,
): Promise<{ id: string; name: string; storageBucket: string } | null> {
  const rows = await sql<{ id: string; name: string; minio_bucket: string }[]>`
    SELECT id, name, minio_bucket FROM buckets
    WHERE id = ${bucketId} AND org_id = ${orgId} AND deleted_at IS NULL
  `;
  if (rows.length === 0) return null;
  return { id: rows[0]!.id, name: rows[0]!.name, storageBucket: rows[0]!.minio_bucket };
}

export async function presignRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/presign/upload",
    { preHandler: [validate({ body: uploadSchema }), requireScope("write")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { bucketId, key, contentType, size, tags } = request.body as z.infer<typeof uploadSchema>;

      const bucket = await resolveOwnedBucket(sql, bucketId, auth.orgId);
      if (!bucket) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Bucket not found" } });
      }

      // Optimistic quota gate at presign (§8.1); authoritative true-up at confirm.
      if (await enforceOptimisticQuota(sql, reply, auth.orgId, size)) return reply;

      const tagging = buildTaggingValue(tags);
      const url = await presignPut(bucket.storageBucket, key, PRESIGN_TTL, tagging ? { tagging } : undefined);

      return {
        url,
        method: "PUT",
        key,
        bucketId,
        bucket: bucket.name,
        expiresIn: PRESIGN_TTL,
        headers: {
          ...(contentType ? { "Content-Type": contentType } : {}),
          ...(tagging ? { "x-amz-tagging": tagging } : {}),
        },
      };
    },
  );

  app.post(
    "/presign/create-multipart",
    { preHandler: [validate({ body: createMultipartSchema }), requireScope("write")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { bucketId, key, contentType, size } = request.body as z.infer<typeof createMultipartSchema>;

      const bucket = await resolveOwnedBucket(sql, bucketId, auth.orgId);
      if (!bucket) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Bucket not found" } });
      }

      // Optimistic reserve of the client-declared size at create (§8.2). Multipart
      // has no in-flight size cap, so this is best-effort; the authoritative true-up
      // still happens at confirm (HEAD of the assembled object).
      if (await enforceOptimisticQuota(sql, reply, auth.orgId, size)) return reply;

      const url = await presignCreateMultipart(bucket.storageBucket, key, PRESIGN_TTL);

      return {
        url,
        method: "POST",
        key,
        bucketId,
        bucket: bucket.name,
        headers: contentType ? { "Content-Type": contentType } : {},
      };
    },
  );

  app.post(
    "/presign/upload-part",
    { preHandler: [validate({ body: uploadPartSchema }), requireScope("write")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { bucketId, key, uploadId, partNumber } = request.body as z.infer<typeof uploadPartSchema>;

      const bucket = await resolveOwnedBucket(sql, bucketId, auth.orgId);
      if (!bucket) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Bucket not found" } });
      }

      const url = await presignUploadPart(bucket.storageBucket, key, uploadId, partNumber, PRESIGN_TTL);

      return { url, method: "PUT", uploadId, partNumber, bucket: bucket.name, key };
    },
  );

  app.post(
    "/presign/complete-upload",
    { preHandler: [validate({ body: completeUploadSchema }), requireScope("write")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { bucketId, key, uploadId } = request.body as z.infer<typeof completeUploadSchema>;

      const bucket = await resolveOwnedBucket(sql, bucketId, auth.orgId);
      if (!bucket) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Bucket not found" } });
      }

      const url = await presignCompleteMultipart(bucket.storageBucket, key, uploadId, PRESIGN_TTL);

      return {
        url,
        method: "POST",
        uploadId,
        key,
        bucketId,
        bucket: bucket.name,
        headers: { "Content-Type": "application/xml" },
      };
    },
  );

  // §8.3 — authoritative record at confirm. After the browser-direct upload (PUT
  // or multipart Complete), the client calls this. We HEAD the object on storage
  // (never trust client-reported size), upsert the authoritative `objects` row,
  // apply the real capacity delta, then enqueue derivative generation. Idempotent
  // on (bucket_id, key): a double-confirm yields a zero delta.
  app.post(
    "/presign/confirm",
    { preHandler: [validate({ body: confirmSchema }), requireScope("write")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { bucketId, key } = request.body as z.infer<typeof confirmSchema>;

      const bucket = await resolveOwnedBucket(sql, bucketId, auth.orgId);
      if (!bucket) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Bucket not found" } });
      }

      // Authoritative measurement: HEAD the uploaded object on storage.
      let head;
      try {
        await refreshS3Client();
        head = await getS3().send(
          new HeadObjectCommand({ Bucket: bucket.storageBucket, Key: key }),
        );
      } catch {
        return reply.status(409).send({
          error: { code: "ObjectNotUploaded", message: "Object not found in storage — upload before confirming" },
        });
      }

      const newSize = BigInt(head.ContentLength ?? 0);
      const etag = (head.ETag ?? "").replace(/"/g, "");
      const contentType = head.ContentType ?? "application/octet-stream";

      // Upsert the objects row + reconcile capacity by the true delta, under the
      // org advisory lock so concurrent confirms/deletes don't race used_bytes.
      const { objectId, delta } = await sql.begin(async (tx) => {
        await acquireOrgLock(tx, auth.orgId);

        const existing = await tx<{ id: string; size: string }[]>`
          SELECT id, size FROM objects
          WHERE bucket_id = ${bucket.id} AND key = ${key} AND deleted_at IS NULL
        `;
        const priorSize = existing.length > 0 ? BigInt(existing[0]!.size) : 0n;

        const upserted = await tx<{ id: string }[]>`
          INSERT INTO objects (bucket_id, key, size, etag, content_type, created_at)
          VALUES (${bucket.id}, ${key}, ${newSize.toString()}::bigint, ${etag}, ${contentType}, now())
          ON CONFLICT (bucket_id, key) WHERE deleted_at IS NULL
          DO UPDATE SET size = ${newSize.toString()}::bigint, etag = ${etag},
                        content_type = ${contentType}, updated_at = now()
          RETURNING id
        `;
        const objectId = upserted[0]!.id;
        const delta = newSize - priorSize;

        if (delta !== 0n) {
          // reconcileCapacity is typed for the top-level Sql; the tx is row-compatible.
          await reconcileCapacity(tx as any, auth.orgId, newSize, priorSize);
          await tx`
            INSERT INTO usage_events (org_id, type, bytes, ts)
            VALUES (${auth.orgId}, 'stored_delta', ${delta.toString()}::bigint, now())
          `;
        }
        return { objectId, delta };
      });

      // Over-quota backstop after the soft true-up: bill auto-capacity (§8).
      if (delta > 0n && (await isOverQuota(sql, auth.orgId, 0n))) {
        try { await autoAddCapacity(sql, auth.orgId); } catch (err) {
          logger.warn({ err, orgId: auth.orgId }, "auto-capacity after confirm failed");
        }
      }

      // Enqueue derivative generation + media probe (worker writes media_assets
      // and thumbnails/posters; it expects the objects row to already exist).
      await getProbeQueue().add(
        "media:probe",
        {
          objectId,
          orgId: auth.orgId,
          bucketId: bucket.id,
          minioBucket: bucket.storageBucket,
          key,
          contentType,
          size: Number(newSize),
        },
        { jobId: `probe-${objectId}-${etag.slice(0, 16) || "v"}` },
      );

      return { objectId, key, size: newSize.toString(), bucketId, status: "confirmed" };
    },
  );

  app.post(
    "/presign/download",
    { preHandler: [requireScope("read"), validate({ body: downloadSchema })] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { objectId, expiresIn } = request.body as z.infer<typeof downloadSchema>;

      const obj = await sql<{ id: string; key: string; storage_bucket: string }[]>`
        SELECT o.id, o.key, b.minio_bucket as storage_bucket
        FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        WHERE o.id = ${objectId} AND b.org_id = ${auth.orgId} AND o.deleted_at IS NULL
      `;
      if (obj.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Object not found" } });
      }

      const url = await presignGet(obj[0]!.storage_bucket, obj[0]!.key, expiresIn);
      return { url, method: "GET", objectId, key: obj[0]!.key, expiresIn };
    },
  );
}

/**
 * Optimistic quota probe: would `addBytes` more push used past allocated? With
 * addBytes=0 it reports whether the org is ALREADY over (post-true-up backstop).
 */
async function isOverQuota(
  sql: any,
  orgId: string,
  addBytes: bigint,
): Promise<boolean> {
  const cap = await sql<{ used_bytes: string; allocated_bytes: string }[]>`
    SELECT used_bytes, allocated_bytes FROM capacity WHERE org_id = ${orgId}
  `;
  if (cap.length === 0) return false;
  return BigInt(cap[0]!.used_bytes) + addBytes > BigInt(cap[0]!.allocated_bytes);
}

/**
 * Optimistic quota gate (§8.1/§8.2) shared by the single-PUT and multipart-create
 * presign paths. If `size` is declared and would push the org over its allocated
 * capacity, attempt billing-backed auto-capacity; if that can't cover it, send a
 * 409 and return `true` so the caller stops. Returns `false` when the request may
 * proceed (no/zero size declared, under quota, or auto-capacity covered it). This
 * is intentionally soft — the authoritative true-up happens at confirm.
 */
async function enforceOptimisticQuota(
  sql: any,
  reply: FastifyReply,
  orgId: string,
  size?: number,
): Promise<boolean> {
  if (typeof size !== "number" || size <= 0) return false;
  if (!(await isOverQuota(sql, orgId, BigInt(size)))) return false;

  const res = await autoAddCapacity(sql, orgId);
  if (!res.added && (await isOverQuota(sql, orgId, BigInt(size)))) {
    await reply.status(409).send({
      error: { code: "InsufficientStorage", message: "Upload would exceed allocated capacity" },
    });
    return true;
  }
  return false;
}
