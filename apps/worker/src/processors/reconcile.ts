import type { Job } from 'bullmq';
import { z } from 'zod';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getDb } from '../db';
import { getS3, refreshS3Client } from '../s3';
import { logger } from '../logger';

/**
 * Nightly STORAGE reconcile (plan §8.4) — PER-KEY orphan/ghost detection.
 *
 * SCOPE (deliberately narrow to avoid clobbering authoritative jobs):
 *   - This job does NOT correct `capacity.used_bytes`. That counter is owned by
 *     the `usage:rollup` pass, whose authoritative formula is
 *     `live objects + BILLABLE derivatives` (apps/worker/src/processors/usage-rollup.ts,
 *     §4.10). Recomputing used_bytes from the `objects` sum alone here would OMIT
 *     billable derivative bytes and fight usage:rollup every run — corrupting
 *     quota. So we leave used_bytes alone.
 *   - Byte-total physical drift (storage total vs tracked) is already surfaced by
 *     the `billing:reconcile` storage sweep (P2.41,
 *     apps/worker/src/processors/billing-reconcile.ts). We do NOT re-emit that.
 *
 * What this job adds that neither of the above does: PER-KEY identification of
 * ORPHANS (keys present in storage with no live `objects` row) and GHOSTS (live
 * `objects` rows whose key is absent from storage), which is the prerequisite for
 * a future GC sweep. v1 is REPORT-ONLY — it never deletes. All sizes are summed
 * BigInt-safe; all storage I/O is isolated so one unreachable bucket warns and
 * the sweep continues.
 *
 * FUTURE: Hetzner egress metering (replacing the deleted gateway metering.ts)
 * will be fed by Hetzner usage metrics. There is NO metrics API wired here yet,
 * so this job does not fabricate egress numbers.
 *
 * NOTE (follow-up): this sweep lists every bucket, as does billing:reconcile's
 * byte-drift sweep — two full listings per night. Folding the per-key detection
 * into that existing sweep would halve the LIST calls; left as an optimization.
 */

export interface StorageReconcileJobData {
  type: 'nightly' | 'manual';
}

export const StorageReconcileJobSchema = z.object({
  type: z.enum(['nightly', 'manual']),
});

interface OrgBucketRow {
  org_id: string;
  bucket_id: string;
  minio_bucket: string;
}

/** Pass 2: best-effort physical drift sweep against Hetzner. Report-only — never
 * deletes. Each bucket's storage I/O is isolated so one unreachable bucket does
 * not abort the sweep. */
async function sweepPhysicalDrift(
  db: ReturnType<typeof getDb>,
  logCtx: Record<string, unknown>,
): Promise<void> {
  await refreshS3Client(); // thin no-op rotation hook; keeps the call-site uniform
  const s3 = getS3();

  // The DB column is still named `minio_bucket` (unchanged) but now backs a
  // Hetzner Object Storage bucket.
  const buckets = await db<OrgBucketRow[]>`
    SELECT b.org_id, b.id AS bucket_id, b.minio_bucket
      FROM buckets b
     WHERE b.deleted_at IS NULL
     ORDER BY b.org_id, b.id
  `;

  for (const { org_id: orgId, bucket_id: bucketId, minio_bucket: bucket } of buckets) {
    // DB-side truth for this bucket: live object keys + summed bytes.
    const dbRows = await db<{ key: string; size: string }[]>`
      SELECT o.key, o.size::text AS size
        FROM objects o
       WHERE o.bucket_id = ${bucketId}
         AND o.deleted_at IS NULL
    `;
    let dbBytes = 0n;
    const dbKeys = new Set<string>();
    for (const r of dbRows) {
      dbBytes += BigInt(r.size ?? '0');
      dbKeys.add(r.key);
    }

    // Storage-side truth: paginate ListObjectsV2 (never an unbounded listing).
    let storageBytes = 0n;
    const storageKeys = new Set<string>();
    try {
      let continuationToken: string | undefined;
      do {
        const resp = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: continuationToken,
            MaxKeys: 1000,
          }),
        );
        for (const obj of resp.Contents ?? []) {
          if (obj.Key === undefined) continue;
          storageKeys.add(obj.Key);
          storageBytes += BigInt(obj.Size ?? 0);
        }
        continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
      } while (continuationToken);
    } catch (err) {
      // Unreachable/missing bucket: warn and continue with the next bucket — an
      // incomplete listing would produce false orphan/ghost counts.
      logger.warn(
        { ...logCtx, orgId, bucket, error: String(err) },
        'Storage reconcile: failed to list Hetzner bucket — skipping its drift sweep',
      );
      continue;
    }

    // ORPHANS: present in storage, no matching live objects row.
    let orphans = 0;
    for (const k of storageKeys) {
      if (!dbKeys.has(k)) orphans++;
    }
    // GHOSTS: live objects row whose key is absent from storage.
    let ghosts = 0;
    for (const k of dbKeys) {
      if (!storageKeys.has(k)) ghosts++;
    }

    logger.info(
      {
        ...logCtx,
        orgId,
        bucket,
        dbBytes: dbBytes.toString(),
        storageBytes: storageBytes.toString(),
        orphans,
        ghosts,
      },
      'Storage reconcile: per-bucket physical comparison (report-only, no deletion in v1)',
    );
  }
}

export async function processStorageReconcileJob(
  job: Job<StorageReconcileJobData>,
): Promise<void> {
  const data = StorageReconcileJobSchema.parse(job.data);
  const logCtx = { jobId: job.id, type: data.type };

  logger.info(logCtx, 'Running storage reconcile');

  const db = getDb();

  // Per-key orphan/ghost sweep is best-effort; a storage outage must not fail the
  // job. used_bytes is NOT touched here — usage:rollup owns it (objects + billable
  // derivatives); byte-total drift is owned by billing:reconcile.
  try {
    await sweepPhysicalDrift(db, logCtx);
  } catch (err) {
    logger.error(
      { ...logCtx, error: String(err) },
      'Storage reconcile: physical drift sweep failed (non-fatal)',
    );
  }

  logger.info(logCtx, 'Storage reconcile complete');
}
