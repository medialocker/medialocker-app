import { FastifyInstance } from "fastify";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { z } from "zod";
import { validate } from "../middleware/validation.js";
import { requireScope } from "../middleware/auth.js";
import { refreshSearchIndex } from "../lib/search-index.js";
import { getS3, refreshS3Client, DERIVED_BUCKET } from "../lib/s3.js";
import { presignGet } from "../lib/presign.js";

const mediaQuerySchema = z.object({
  bucketId: z.string().uuid().optional(),
  kind: z.enum(["image", "video", "audio", "pdf", "3d", "other"]).optional(),
  sort: z.enum(["created_at", "size", "key"]).default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().optional(),
  tags: z.string().optional(),
  categories: z.string().optional(),
  sets: z.string().optional(),
  storyboards: z.string().optional(),
  sizeMin: z.coerce.number().int().min(0).optional(),
  sizeMax: z.coerce.number().int().min(0).optional(),
  // P2.13: date range filters must be valid ISO-8601 timestamps so they can be
  // safely bound + cast to timestamptz (no malformed-cast errors from PG).
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

const updateMetadataSchema = z.object({
  metadata: z.record(z.string(), z.string()),
});

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/media",
    { preHandler: [validate({ query: mediaQuerySchema }), requireScope("read")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const q = (request as any).validatedQuery as z.infer<typeof mediaQuerySchema>;

      // Compose the WHERE clause from parameterized postgres.js fragments so no
      // user input is ever string-interpolated into SQL. (The previous version
      // built `$N` placeholders but passed them to sql.unsafe() without the
      // params array, so any filtered query threw at runtime.)
      const filters = [sql`o.deleted_at IS NULL`, sql`b.org_id = ${auth.orgId}`];
      if (q.bucketId) filters.push(sql`o.bucket_id = ${q.bucketId}`);
      if (q.kind) filters.push(sql`ma.kind = ${q.kind}`);
      if (q.search) {
        filters.push(sql`EXISTS (
          SELECT 1 FROM search_index si
          WHERE si.object_id = o.id
            AND si.tsv @@ plainto_tsquery('english', ${q.search})
        )`);
      }
      if (q.tags) {
        const tagNames = q.tags.split(",").map((t) => t.trim()).filter(Boolean);
        if (tagNames.length > 0) {
          filters.push(sql`EXISTS (
            SELECT 1 FROM object_tags ot
            JOIN tags t ON t.id = ot.tag_id
            WHERE ot.object_id = o.id AND t.name = ANY(${tagNames})
          )`);
        }
      }
      if (q.categories) {
        const catNames = q.categories.split(",").map((c) => c.trim()).filter(Boolean);
        if (catNames.length > 0) {
          filters.push(sql`EXISTS (
            SELECT 1 FROM object_categories oc
            JOIN categories c ON c.id = oc.category_id
            WHERE oc.object_id = o.id AND c.name = ANY(${catNames})
          )`);
        }
      }
      if (q.sets) {
        const setNames = q.sets.split(",").map((s) => s.trim()).filter(Boolean);
        if (setNames.length > 0) {
          filters.push(sql`EXISTS (
            SELECT 1 FROM set_items sit
            JOIN sets s ON s.id = sit.set_id
            WHERE sit.object_id = o.id AND s.name = ANY(${setNames})
          )`);
        }
      }
      if (q.storyboards) {
        const sbNames = q.storyboards.split(",").map((s) => s.trim()).filter(Boolean);
        if (sbNames.length > 0) {
          filters.push(sql`EXISTS (
            SELECT 1 FROM storyboard_clips sc
            JOIN storyboards sb ON sb.id = sc.storyboard_id
            WHERE sc.object_id = o.id AND sb.name = ANY(${sbNames})
          )`);
        }
      }
      if (q.sizeMin !== undefined) filters.push(sql`o.size >= ${q.sizeMin}`);
      if (q.sizeMax !== undefined) filters.push(sql`o.size <= ${q.sizeMax}`);
      if (q.dateFrom) filters.push(sql`o.created_at >= ${q.dateFrom}::timestamptz`);
      if (q.dateTo) filters.push(sql`o.created_at <= ${q.dateTo}::timestamptz`);

      let where = filters[0]!;
      for (let i = 1; i < filters.length; i++) where = sql`${where} AND ${filters[i]!}`;

      // sort/order come from a fixed whitelist (zod enums), so mapping them to
      // literal identifiers is safe to splice with sql.unsafe.
      const sortCol = q.sort === "size" ? "o.size" : q.sort === "key" ? "o.key" : "o.created_at";
      const orderDir = q.order === "asc" ? "ASC" : "DESC";

      const totalRows = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count
        FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        LEFT JOIN media_assets ma ON ma.object_id = o.id
        WHERE ${where}
      `;
      const total = parseInt(totalRows[0]!.count, 10);

      const rows = await sql`
        SELECT o.id, o.bucket_id, o.key, o.size, o.content_type, o.created_at,
               b.name as bucket_name,
               ma.kind, ma.width, ma.height, ma.duration_ms
        FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        LEFT JOIN media_assets ma ON ma.object_id = o.id
        WHERE ${where}
        ORDER BY ${sql.unsafe(`${sortCol} ${orderDir}`)}
        LIMIT ${q.limit} OFFSET ${q.offset}
      `;

      const facetKinds = await sql<{ kind: string | null; cnt: string }[]>`
        SELECT ma.kind, COUNT(*)::text as cnt
        FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        LEFT JOIN media_assets ma ON ma.object_id = o.id
        WHERE ${where}
        GROUP BY ma.kind
      `;
      const kinds: Record<string, number> = {};
      for (const row of facetKinds) {
        if (row.kind) kinds[row.kind] = parseInt(row.cnt, 10);
      }

      const facetTags = await sql<{ name: string; cnt: string }[]>`
        SELECT t.name, COUNT(*)::text as cnt
        FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        LEFT JOIN media_assets ma ON ma.object_id = o.id
        JOIN object_tags ot ON ot.object_id = o.id
        JOIN tags t ON t.id = ot.tag_id
        WHERE ${where}
        GROUP BY t.name
      `;
      const tags: Record<string, number> = {};
      for (const row of facetTags) {
        tags[row.name] = parseInt(row.cnt, 10);
      }

      const facetCategories = await sql<{ name: string; cnt: string }[]>`
        SELECT c.name, COUNT(*)::text as cnt
        FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        LEFT JOIN media_assets ma ON ma.object_id = o.id
        JOIN object_categories oc ON oc.object_id = o.id
        JOIN categories c ON c.id = oc.category_id
        WHERE ${where}
        GROUP BY c.name
      `;
      const categories: Record<string, number> = {};
      for (const row of facetCategories) {
        categories[row.name] = parseInt(row.cnt, 10);
      }

      const facetSets = await sql<{ name: string; cnt: string }[]>`
        SELECT s.name, COUNT(*)::text as cnt
        FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        LEFT JOIN media_assets ma ON ma.object_id = o.id
        JOIN set_items sit ON sit.object_id = o.id
        JOIN sets s ON s.id = sit.set_id
        WHERE ${where}
        GROUP BY s.name
      `;
      const sets: Record<string, number> = {};
      for (const row of facetSets) {
        sets[row.name] = parseInt(row.cnt, 10);
      }

      const facetStoryboards = await sql<{ name: string; cnt: string }[]>`
        SELECT sb.name, COUNT(*)::text as cnt
        FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        LEFT JOIN media_assets ma ON ma.object_id = o.id
        JOIN storyboard_clips sc ON sc.object_id = o.id
        JOIN storyboards sb ON sb.id = sc.storyboard_id
        WHERE ${where}
        GROUP BY sb.name
      `;
      const storyboards: Record<string, number> = {};
      for (const row of facetStoryboards) {
        storyboards[row.name] = parseInt(row.cnt, 10);
      }

      return {
        items: rows,
        total,
        limit: q.limit,
        offset: q.offset,
        facets: { kinds, tags, categories, sets, storyboards },
      };
    },
  );

  app.get(
    "/media/:id",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }) }), requireScope("read")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id } = (request as any).validatedParams as { id: string };

      const rows = await sql`
        SELECT o.*, b.name as bucket_name,
               ma.kind, ma.width, ma.height, ma.duration_ms, ma.codec, ma.frame_rate,
               ma.has_audio, ma.probe_json
        FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        LEFT JOIN media_assets ma ON ma.object_id = o.id
        WHERE o.id = ${id} AND b.org_id = ${auth.orgId} AND o.deleted_at IS NULL
      `;

      if (rows.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Media not found" } });
      }

      const metadata = await sql`
        SELECT key, value FROM object_user_metadata WHERE object_id = ${id}
      `;

      const tags = await sql`
        SELECT t.id, t.name, t.slug FROM tags t
        JOIN object_tags ot ON ot.tag_id = t.id
        WHERE ot.object_id = ${id}
      `;

      return {
        ...rows[0],
        metadata: Object.fromEntries(metadata.map((m: any) => [m.key, m.value])),
        tags,
      };
    },
  );

  app.get(
    "/media/:id/thumbnail",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }) }), requireScope("read")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id } = (request as any).validatedParams as { id: string };

      // Resolve a preview derivative for the object (scoped to the org), preferring
      // the image thumbnail, then the video poster frame. These live in the private
      // `ml-derived` system bucket. Bytes-direct (§7.4): instead of proxying the
      // bytes, return a short-lived presigned GET so the browser fetches the
      // derivative straight from Hetzner.
      const rows = await sql<{ minio_key: string; type: string }[]>`
        SELECT d.minio_key, d.type
        FROM derivatives d
        JOIN objects o ON o.id = d.object_id
        JOIN buckets b ON b.id = o.bucket_id
        WHERE d.object_id = ${id}
          AND b.org_id = ${auth.orgId}
          AND o.deleted_at IS NULL
          AND d.type IN ('thumbnail', 'poster')
        ORDER BY (d.type = 'thumbnail') DESC
        LIMIT 1
      `;
      if (rows.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "No thumbnail available" } });
      }

      const url = await presignGet(DERIVED_BUCKET, rows[0]!.minio_key, 86400);
      return { url, expiresIn: 86400 };
    },
  );

  app.get(
    "/media/:id/stream",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }) }), requireScope("read")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id } = (request as any).validatedParams as { id: string };

      const rows = await sql<{ key: string; minio_bucket: string; content_type: string; bucket_name: string }[]>`
        SELECT o.key, b.minio_bucket, o.content_type, b.name as bucket_name
        FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        WHERE o.id = ${id} AND b.org_id = ${auth.orgId} AND o.deleted_at IS NULL
      `;
      if (rows.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Media not found" } });
      }
      const obj = rows[0]!;

      // Bytes-direct (§7.4): redirect to a presigned GET on Hetzner signed with
      // the master credential. The browser fetches bytes straight from storage.
      const url = await presignGet(obj.minio_bucket, obj.key, 3600);
      return reply.redirect(url, 302);
    },
  );

  app.put(
    "/media/:id/metadata",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }), body: updateMetadataSchema }), requireScope("write")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id } = (request as any).validatedParams as { id: string };
      const { metadata } = request.body as z.infer<typeof updateMetadataSchema>;

      const obj = await sql`
        SELECT o.id FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        WHERE o.id = ${id} AND b.org_id = ${auth.orgId} AND o.deleted_at IS NULL
      `;

      if (obj.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Media not found" } });
      }

      for (const [key, value] of Object.entries(metadata)) {
        await sql`
          INSERT INTO object_user_metadata (object_id, key, value)
          VALUES (${id}, ${key}, ${value})
          ON CONFLICT (object_id, key) DO UPDATE SET value = ${value}
        `;
      }

      await refreshSearchIndex(sql, id);

      const updated = await sql`SELECT key, value FROM object_user_metadata WHERE object_id = ${id}`;
      return { objectId: id, metadata: Object.fromEntries(updated.map((m: any) => [m.key, m.value])) };
    },
  );

  app.delete(
    "/media/:id",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }) }), requireScope("delete")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id } = (request as any).validatedParams as { id: string };

      // P2.15 — OBJECT SOFT-DELETE CLEANUP CONTRACT:
      //   1. The DB row is SOFT-deleted (objects.deleted_at = now()); the row is
      //      retained as the durable tombstone so any future storage-reconcile
      //      sweep can re-detect and re-attempt cleanup idempotently.
      //   2. The reserved capacity is released and a negative stored_delta usage
      //      event is emitted in the SAME transaction (no upward drift).
      //   3. Source object bytes AND derivative bytes are removed from MinIO
      //      INLINE here, best-effort, using the control plane's internal MinIO
      //      credentials (the api can read/write its own MinIO; customer keys
      //      cannot). There is no separate async reconcile worker today, so the
      //      delete path itself must remove the bytes — otherwise soft-deleted
      //      objects would leak storage forever. Failures are swallowed (the row
      //      tombstone is the reconcile source of truth), so a transiently
      //      unreachable MinIO never blocks the logical delete.
      //
      // Fetch the source object's MinIO location + derivative keys BEFORE the
      // transaction soft-deletes/removes the rows, so we still have them to clean.
      const srcRows = await sql<{ key: string; minio_bucket: string }[]>`
        SELECT o.key, b.minio_bucket
        FROM objects o
        JOIN buckets b ON b.id = o.bucket_id
        WHERE o.id = ${id} AND b.org_id = ${auth.orgId} AND o.deleted_at IS NULL
      `;
      const derivKeys = await sql<{ minio_key: string }[]>`
        SELECT minio_key FROM derivatives WHERE object_id = ${id}
      `;

      // Soft-delete + release the reserved capacity + emit a negative stored
      // delta + audit, atomically. (The gateway delete path already releases
      // capacity on soft-delete; the control-plane route must do the same so the
      // counter doesn't drift upward forever.) MinIO object cleanup is handled
      // out-of-band by the storage reconcile job.
      const deleted = await sql.begin(async (tx) => {
        const rows = await tx<{ size: string }[]>`
          SELECT o.size FROM objects o
          JOIN buckets b ON b.id = o.bucket_id
          WHERE o.id = ${id} AND b.org_id = ${auth.orgId} AND o.deleted_at IS NULL
        `;
        if (rows.length === 0) return false;
        // BigInt, not Number: object sizes can exceed 2^53 bytes; Number() would
        // lose precision and drift `used_bytes`. postgres.js serializes a BigInt
        // param to the bigint column losslessly. (C10)
        const size = BigInt(rows[0]!.size);

        await tx`UPDATE objects SET deleted_at = now(), updated_at = now() WHERE id = ${id}`;
        await tx`DELETE FROM derivatives WHERE object_id = ${id}`;

        if (size > 0n) {
          // Serialize BigInt → string + ::bigint cast (this pool isn't configured
          // for native bigint params); keeps full precision into the bigint column.
          await tx`UPDATE capacity SET used_bytes = GREATEST(0, used_bytes - ${size.toString()}::bigint) WHERE org_id = ${auth.orgId}`;
          await tx`INSERT INTO usage_events (org_id, type, bytes, ts) VALUES (${auth.orgId}, 'stored_delta', ${(-size).toString()}::bigint, now())`;
        }
        await tx`
          INSERT INTO audit_log (org_id, actor, action, target, ip)
          VALUES (${auth.orgId}, ${auth.userId ?? auth.apiKeyId ?? "system"}, 'object.delete', ${id}, ${request.ip})
        `;
        return true;
      });

      if (!deleted) {
        return reply.status(404).send({ error: { code: "NotFound", message: "Media not found" } });
      }

      // Best-effort MinIO byte removal (contract step 3). Refresh creds once,
      // then remove the source object from the customer bucket and every
      // derivative from the system `ml-derived` bucket. Any failure is left for
      // the row tombstone to drive a future reconcile rather than failing here.
      if (srcRows.length > 0 || derivKeys.length > 0) {
        await refreshS3Client();
        const s3 = getS3();
        if (srcRows.length > 0) {
          try {
            await s3.send(
              new DeleteObjectCommand({ Bucket: srcRows[0]!.minio_bucket, Key: srcRows[0]!.key }),
            );
          } catch { /* best-effort — tombstone drives reconcile */ }
        }
        for (const dk of derivKeys) {
          try {
            await s3.send(new DeleteObjectCommand({ Bucket: DERIVED_BUCKET, Key: dk.minio_key }));
          } catch { /* best-effort */ }
        }
      }

      return { status: "deleted" };
    },
  );
}
