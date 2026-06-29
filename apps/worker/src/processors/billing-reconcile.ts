import type { Job } from 'bullmq';
import { z } from 'zod';
import type Stripe from 'stripe';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getStripeClient } from '@medialocker/billing';
import { getConfig } from '@medialocker/config';
import { getDb } from '../db';
import { getS3, refreshS3Client } from '../s3';
import { logger } from '../logger';

// Drift tolerance for the MinIO-vs-Postgres storage reconcile: only flag when the
// physical/logical gap exceeds 1% of the tracked total (and is non-trivial in
// absolute bytes), to avoid noise from in-flight uploads and eventual consistency.
const STORAGE_DRIFT_PCT = 0.01;
const STORAGE_DRIFT_MIN_BYTES = 1_000_000; // 1 MB floor

/**
 * Nightly STORAGE reconcile (P2.41): compare each org's tracked usage against the
 * ACTUAL bytes physically stored in MinIO — not only the Postgres `objects` sum,
 * which can silently diverge from reality after failed deletes, orphaned
 * multipart parts, or out-of-band bucket mutation.
 *
 * For every active org we page through each of its MinIO buckets with
 * ListObjectsV2 (paginated via ContinuationToken — never a single unbounded
 * listing) and sum object sizes. We then compare that physical total against the
 * Postgres-tracked `capacity.used_bytes`.
 *
 * DETECTION + LOGGING ONLY — we deliberately do NOT auto-correct `used_bytes`
 * from the MinIO total here, because the live bucket also contains data the
 * billing model treats differently (in-flight multipart uploads not yet
 * committed, soft-deleted objects pending GC, derivatives stored in a separate
 * bucket). Silently overwriting the authoritative quota counter from a raw bucket
 * scan would mis-bill. The usage-rollup reconcile pass already corrects
 * `used_bytes` from the authoritative Postgres view (live objects + billable
 * derivatives); this pass surfaces drift between THAT view and physical storage
 * so an operator can investigate orphaned/leaked bytes. Drift beyond tolerance is
 * logged at WARN with both totals.
 */
export async function reconcileStorageAgainstMinio(
  db: ReturnType<typeof getDb>,
  logCtx: Record<string, unknown>,
): Promise<void> {
  await refreshS3Client(); // pick up a rotated MinIO secret if one exists
  const s3 = getS3();

  const orgBuckets = await db<{ org_id: string; minio_bucket: string }[]>`
    SELECT b.org_id, b.minio_bucket
      FROM buckets b
     WHERE b.deleted_at IS NULL
     ORDER BY b.org_id
  `;

  // Group MinIO bucket names per org so we sum across all of an org's buckets.
  const bucketsByOrg = new Map<string, string[]>();
  for (const row of orgBuckets) {
    const list = bucketsByOrg.get(row.org_id) ?? [];
    list.push(row.minio_bucket);
    bucketsByOrg.set(row.org_id, list);
  }

  for (const [orgId, bucketNames] of bucketsByOrg) {
    let physicalBytes = 0n;
    let listFailed = false;

    for (const bucket of bucketNames) {
      let continuationToken: string | undefined;
      try {
        do {
          const resp = await s3.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              ContinuationToken: continuationToken,
              MaxKeys: 1000,
            }),
          );
          for (const obj of resp.Contents ?? []) {
            physicalBytes += BigInt(obj.Size ?? 0);
          }
          continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
        } while (continuationToken);
      } catch (err) {
        // A missing/unreachable bucket must not abort the whole reconcile — record
        // it and move on so other orgs still get checked.
        listFailed = true;
        logger.warn(
          { ...logCtx, orgId, bucket, error: String(err) },
          'Storage reconcile: failed to list MinIO bucket — skipping its bytes',
        );
      }
    }

    if (listFailed) continue; // an incomplete physical total would produce a false drift

    const capRows = await db<{ used_bytes: string }[]>`
      SELECT used_bytes FROM capacity WHERE org_id = ${orgId} LIMIT 1
    `;
    const trackedBytes = BigInt(capRows[0]?.used_bytes ?? '0');

    const diff = physicalBytes > trackedBytes
      ? physicalBytes - trackedBytes
      : trackedBytes - physicalBytes;
    const denom = trackedBytes > 0n ? trackedBytes : 1n;
    // Integer-safe percentage check: diff/denom > STORAGE_DRIFT_PCT.
    const overPct = Number(diff) / Number(denom) > STORAGE_DRIFT_PCT;

    if (diff > BigInt(STORAGE_DRIFT_MIN_BYTES) && overPct) {
      logger.warn(
        {
          ...logCtx,
          orgId,
          trackedBytes: trackedBytes.toString(),
          physicalBytes: physicalBytes.toString(),
          driftBytes: diff.toString(),
        },
        'Storage reconcile: MinIO physical bytes drift from tracked usage — investigate orphaned/leaked storage',
      );
    }
  }
}

export interface BillingReconcileJobData {
  type: 'nightly' | 'manual';
}

export const BillingReconcileJobSchema = z.object({
  type: z.enum(['nightly', 'manual']),
});

export async function processBillingReconcileJob(
  job: Job<BillingReconcileJobData>,
): Promise<void> {
  const data = BillingReconcileJobSchema.parse(job.data);
  const logCtx = { jobId: job.id, type: data.type };

  logger.info(logCtx, 'Running billing reconciliation');

  const cfg = getConfig();
  const db = getDb();

  // Storage reconcile (P2.41) is independent of Stripe — run it even when billing
  // is unconfigured (self-hosted with no payment provider still has storage drift
  // to detect). Best-effort: a failure here must not block billing reconcile.
  try {
    await reconcileStorageAgainstMinio(db, logCtx);
  } catch (err) {
    logger.error({ ...logCtx, error: String(err) }, 'Storage reconcile failed (non-fatal)');
  }

  if (!cfg.STRIPE_SECRET_KEY) {
    logger.warn(logCtx, 'STRIPE_SECRET_KEY not configured — skipping billing reconciliation');
    return;
  }

  const stripe = getStripeClient();

  const activeSubscriptions = await db`
    SELECT
      s.org_id,
      s.stripe_subscription_id,
      s.plan_id,
      s.status,
      c.allocated_bytes,
      c.used_bytes
    FROM subscriptions s
    JOIN capacity c ON c.org_id = s.org_id
    WHERE s.status = 'active'
  `;

  for (const sub of activeSubscriptions) {
    try {
      const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, {
        expand: ['items.data.price'],
      });

      const dbAddons = await db`
        SELECT id, stripe_item_id, gb, created_at
        FROM billing_addons
        WHERE org_id = ${sub.org_id}
        ORDER BY created_at ASC, id ASC
      `;

      const stripeItems = new Map<string, { gb: number; quantity: number }>();
      for (const item of stripeSub.items.data) {
        const price = item.price as Stripe.Price;
        const metadata = price.metadata || {};
        if (metadata['type'] === 'capacity_addon') {
          stripeItems.set(item.id, {
            gb: parseInt(metadata['gb'] || '1', 10),
            quantity: item.quantity || 0,
          });
        }
      }

      // All capacity add-ons share ONE Stripe subscription item (addCapacity
      // increments its quantity), so MANY billing_addons rows map to a single
      // stripe_item_id. Group the rows by item before reconciling. (C1)
      const dbByItem = new Map<string, Array<{ id: string; gb: number }>>();
      for (const a of dbAddons) {
        const list = dbByItem.get(a.stripe_item_id) ?? [];
        list.push({ id: a.id as string, gb: Number(a.gb) });
        dbByItem.set(a.stripe_item_id, list);
      }

      // Drift detection (both directions).
      for (const itemId of dbByItem.keys()) {
        if (!stripeItems.has(itemId)) {
          logger.warn(
            { orgId: sub.org_id, stripeItemId: itemId },
            'DB addon not found in Stripe subscription — possible drift',
          );
        }
      }

      for (const [itemId, si] of stripeItems) {
        const rows = dbByItem.get(itemId);
        if (!rows || rows.length === 0) {
          logger.warn(
            { orgId: sub.org_id, stripeItemId: itemId },
            'Stripe addon not found in billing_addons — possible drift',
          );
          continue;
        }

        const expectedGb = si.gb * si.quantity;
        const sumDbGb = rows.reduce((s, r) => s + r.gb, 0);
        // Reconcile the GROUP's SUM(gb) to Stripe's expected total — NOT each row
        // to the total (the old `find()` + `WHERE stripe_item_id` rewrote every
        // sibling row to the SUM, doubling the ledger for ≥2 add-ons). Distribute
        // the difference across rows iteratively (oldest first), clamping each row
        // to a min of 0.001 GB, so the group SUM always matches without destroying
        // sibling rows' purchase history. (C1)
        if (sumDbGb !== expectedGb) {
          const minGb = 0.001;
          let remainingDelta = expectedGb - sumDbGb;
          logger.warn(
            { orgId: sub.org_id, stripeItemId: itemId, dbSumGb: sumDbGb, stripeGb: expectedGb },
            'GB mismatch between DB and Stripe addon — distributing difference across rows iteratively',
          );
          for (const row of rows) {
            if (Math.abs(remainingDelta) < 0.0001) break;
            let newGb: number;
            if (remainingDelta > 0) {
              newGb = row.gb + remainingDelta;
              remainingDelta = 0;
            } else {
              const maxDeduction = row.gb - minGb;
              const deduction = Math.min(maxDeduction, -remainingDelta);
              newGb = row.gb - deduction;
              remainingDelta += deduction;
            }
            await db`UPDATE billing_addons SET gb = ${newGb} WHERE id = ${row.id}`;
          }
        }
      }

      const allocatedGbExpected = stripeItems.size > 0
        ? Array.from(stripeItems.values()).reduce((sum, si) => sum + si.gb * si.quantity, 0)
        : 0;

      // Reconcile allocated capacity for EVERY active org — NOT only those with
      // add-ons. The old `allocatedGbExpected > 0` guard meant a plan-only org
      // whose allocated_bytes drifted from its plan's included GB was never
      // corrected. With no add-ons, totalAllocatedGb collapses to planGb. (C2)
      const currentPlanAllocated = await db`
        SELECT included_gb FROM plans WHERE id = ${sub.plan_id}
      `;
      const planGb = Number(currentPlanAllocated[0]?.included_gb ?? 0);
      // allocatedGbExpected is already a GB sum (si.gb * quantity), so it adds
      // directly to the plan's included GB — do NOT divide by 1e9.
      const totalAllocatedGb = planGb + allocatedGbExpected;

      const dbAllocatedGb = Number(sub.allocated_bytes) / 1_000_000_000;
      if (Math.abs(dbAllocatedGb - totalAllocatedGb) > 0.1) {
        // Correct the drift, not just warn (§9.10 / P1): the authoritative
        // allocation is plan included GB + confirmed Stripe add-on GB. Same
        // formula confirmAddOn uses, so this is idempotent with it.
        const correctedBytes = Math.round(totalAllocatedGb * 1_000_000_000);
        await db`
          UPDATE capacity SET allocated_bytes = ${correctedBytes}::bigint
           WHERE org_id = ${sub.org_id}
        `;
        logger.warn(
          {
            orgId: sub.org_id,
            dbAllocatedGb,
            computedAllocatedGb: totalAllocatedGb,
          },
          'Allocated bytes drift detected — corrected to computed allocation',
        );
      }
    } catch (err) {
      logger.error(
        { orgId: sub.org_id, error: String(err) },
        'Failed to reconcile subscription',
      );
    }
  }

  logger.info(logCtx, 'Billing reconciliation complete');
}
