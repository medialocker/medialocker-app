import type { Job } from 'bullmq';
import { z } from 'zod';
import { trimUsageEventsOlderThan } from '@medialocker/db';
import { getDb } from '../db';
import { logger } from '../logger';

export interface UsageRollupJobData {
  type: 'periodic' | 'manual';
  periodStart?: string;
  periodEnd?: string;
}

export const UsageRollupJobSchema = z.object({
  type: z.enum(['periodic', 'manual']),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
});

const DRIFT_THRESHOLD = 0.001;

export async function processUsageRollupJob(job: Job<UsageRollupJobData>): Promise<void> {
  const data = UsageRollupJobSchema.parse(job.data);
  const db = getDb();
  const now = new Date();

  let since: Date;
  try {
    const lastRollup = await db<{ last_rollup_at: Date }[]>`
      SELECT last_rollup_at FROM rollup_state WHERE key = 'usage_rollup' LIMIT 1
    `;
    since = lastRollup[0]?.last_rollup_at
      ? new Date(lastRollup[0]!.last_rollup_at)
      : new Date(now.getTime() - 15 * 60 * 1000);
  } catch {
    since = new Date(now.getTime() - 15 * 60 * 1000);
  }

  const periodEnd = data.periodEnd || now.toISOString();
  const periodStart = data.periodStart || since.toISOString();

  const logCtx = { periodStart, periodEnd, jobId: job.id };

  logger.info(logCtx, 'Running usage rollup');

  // Aggregate egress bytes and request count per org in ONE grouped query.
  // request_count must count ONLY rows whose `type = 'request'` (P2.33) — filtered
  // in SQL via COUNT(*) FILTER, not by counting every usage_events type — and
  // egress_bytes sums only `type = 'egress'` bytes. A bare COUNT(*) here would
  // have folded stored_delta / egress / every other event type into the request
  // tally, massively over-reporting billable requests.
  const events = await db<{
    org_id: string;
    egress_bytes: string;
    request_count: number;
  }[]>`
    SELECT
      org_id,
      COALESCE(SUM(bytes) FILTER (WHERE type = 'egress'), 0)::bigint AS egress_bytes,
      COUNT(*) FILTER (WHERE type = 'request')::int AS request_count
    FROM usage_events
    WHERE ts >= ${periodStart}::timestamptz
      AND ts < ${periodEnd}::timestamptz
    GROUP BY org_id
  `;

  for (const row of events) {
    const existingRollup = await db`
      SELECT id FROM usage_rollups
      WHERE org_id = ${row.org_id}
        AND period = ${periodEnd}::date
      LIMIT 1
    `;

    const existing = existingRollup[0];
    if (existing) {
      // stored_bytes_max is set from an ABSOLUTE snapshot in the reconcile pass
      // below (§4.9) — NOT from a sum of signed stored_delta events, which would
      // only capture the net change in the window, not the stored total.
      await db`
        UPDATE usage_rollups
        SET
          egress_bytes = egress_bytes + ${row.egress_bytes},
          request_count = request_count + ${row.request_count}
        WHERE id = ${existing.id}
      `;
    } else {
      await db`
        INSERT INTO usage_rollups (org_id, period, stored_bytes_max, egress_bytes, request_count)
        VALUES (
          ${row.org_id},
          ${periodEnd}::date,
          0,
          ${row.egress_bytes},
          ${row.request_count}
        )
      `;
    }
  }

  // Single grouped query (no per-org N+1): join each org's tracked capacity to
  // its recomputed actual stored bytes (scoped via buckets — objects has no
  // org_id). Only drifted orgs get a targeted UPDATE below.
  // actual_bytes = live objects + BILLABLE derivatives (§4.10) — derivatives that
  // count against quota must be included or the reconcile under-counts.
  const reconcileRows = await db`
    SELECT c.org_id,
           c.used_bytes,
           (COALESCE(a.total, 0) + COALESCE(d.total, 0))::bigint AS actual_bytes
      FROM capacity c
      LEFT JOIN (
        SELECT b.org_id, COALESCE(SUM(o.size), 0)::bigint AS total
          FROM objects o
          JOIN buckets b ON b.id = o.bucket_id
         WHERE o.deleted_at IS NULL
         GROUP BY b.org_id
      ) a ON a.org_id = c.org_id
      LEFT JOIN (
        SELECT b.org_id, COALESCE(SUM(dv.bytes), 0)::bigint AS total
          FROM derivatives dv
          JOIN objects o ON o.id = dv.object_id
          JOIN buckets b ON b.id = o.bucket_id
         WHERE dv.billable = true AND o.deleted_at IS NULL
         GROUP BY b.org_id
      ) d ON d.org_id = c.org_id
  `;

  for (const row of reconcileRows) {
    const actualUsed = Number(row.actual_bytes);
    const trackedUsed = Number(row.used_bytes);

    // Record the absolute stored-bytes snapshot for the period as a running MAX
    // (§4.9): the rollup tracks peak absolute stored bytes, not a delta sum.
    if (actualUsed > 0) {
      await db`
        INSERT INTO usage_rollups (org_id, period, stored_bytes_max, egress_bytes, request_count)
        VALUES (${row.org_id}, ${periodEnd}::date, ${actualUsed}, 0, 0)
        ON CONFLICT (org_id, period) DO UPDATE SET
          stored_bytes_max = GREATEST(usage_rollups.stored_bytes_max, ${actualUsed})
      `;
    }

    if (actualUsed === 0 && trackedUsed === 0) continue;

    const drift = trackedUsed === 0
      ? 1
      : Math.abs(actualUsed - trackedUsed) / trackedUsed;

    if (drift > DRIFT_THRESHOLD) {
      logger.warn(
        {
          orgId: row.org_id,
          trackedUsed,
          actualUsed,
          drift: `${(drift * 100).toFixed(2)}%`,
        },
        'Usage drift detected — reconciling',
      );

      await db`
        UPDATE capacity
        SET used_bytes = ${actualUsed}
        WHERE org_id = ${row.org_id}
      `;
    }
  }

  // Advance the high-water mark to the END of the window we just processed (NOT
  // `now()`): events that arrived between periodEnd and now() have NOT been rolled
  // up yet and must be picked up by the next run. Persisting periodEnd makes the
  // rollup exactly-once over the time axis instead of skipping the tail. (P2.36)
  try {
    await db`
      INSERT INTO rollup_state (key, last_rollup_at) VALUES ('usage_rollup', ${periodEnd}::timestamptz)
      ON CONFLICT (key) DO UPDATE SET last_rollup_at = EXCLUDED.last_rollup_at
    `;
  } catch {
    /* table may not exist — best-effort */
  }

  // Trim rolled-up usage_events so the time-series table doesn't grow unbounded
  // (P2.40). Everything up to the just-advanced watermark has been aggregated into
  // usage_rollups, so the raw rows are no longer needed for billing. We retain a
  // 7-day window of raw events for debugging/audit before deleting; the batched
  // helper deletes in chunks so a single run never holds a giant DELETE. This is
  // best-effort — a trim failure must not fail the (already-committed) rollup.
  try {
    const deleted = await trimUsageEventsOlderThan(7);
    if (deleted > 0n) {
      logger.info({ ...logCtx, deleted: deleted.toString() }, 'Trimmed rolled-up usage_events');
    }
  } catch (err) {
    logger.warn({ ...logCtx, error: String(err) }, 'usage_events trim failed (non-fatal)');
  }

  logger.info(logCtx, 'Usage rollup complete');
}
