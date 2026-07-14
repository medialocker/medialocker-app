/**
 * Minimal fixture seeding for the integration harness.
 *
 * `seedOrg()` creates one org with a capacity row (allocated/used in bytes) and
 * a buckets row, returning the ids the tests need. It mirrors the column shapes
 * used by @medialocker/db (snake_case, BIGINT byte counts). Each call uses a
 * unique slug/bucket so tests are isolated even when run against the same
 * database. No physical object-storage bucket is created — the remaining suites
 * only exercise the capacity/billing SQL paths, and tenant storage now lives on
 * Hetzner behind presigned URLs (no in-process data plane).
 *
 * `seedPlanAndSubscription()` adds the rows that @medialocker/billing's
 * addCapacity/autoAddCapacity require (a plan with a stripe_addon_price_id and
 * an active subscription with a current_period_end), used by the proration and
 * capacity tests.
 */
import type { Sql } from "postgres";
import { randomUUID, createHash } from "node:crypto";

const BYTES_PER_GB = 1_000_000_000;

export function gb(n: number): bigint {
  return BigInt(Math.round(n * BYTES_PER_GB));
}

/**
 * Derive the storage bucket name stored in buckets.minio_bucket. The column name
 * is legacy (predates the Hetzner migration); the value is just a deterministic,
 * DNS-safe identifier. Kept here so seeded rows satisfy the schema's NOT NULL +
 * UNIQUE constraint on that column.
 */
export function buildMinioBucketName(orgId: string, bucketName: string): string {
  const hash = createHash("sha256")
    .update(`${orgId}\n${bucketName}`)
    .digest("hex")
    .slice(0, 12);
  const MAX_TOTAL = 63;
  const reserved = "ml-".length + hash.length + 2;
  const slugMax = MAX_TOTAL - reserved;
  const slug = bucketName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, slugMax)
    .replace(/^-+|-+$/g, "");
  const middle = slug.length > 0 ? `${slug}-` : "";
  return `ml-${middle}${hash}`;
}

export interface SeededOrg {
  orgId: string;
  slug: string;
  bucketId: string;
  bucketName: string;
  minioBucket: string;
}

export interface SeedOrgOpts {
  allocatedBytes?: bigint;
  usedBytes?: bigint;
  autoEnabled?: boolean;
  incrementGb?: number;
  thresholdPct?: number;
  maxMonthlySpendCents?: number;
}

export async function seedOrg(
  sql: Sql,
  opts: SeedOrgOpts = {},
): Promise<SeededOrg> {
  const unique = randomUUID().slice(0, 8);
  const slug = `itest-${unique}`;
  const name = `Integration Org ${unique}`;

  const orgRows = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES (${name}, ${slug}) RETURNING id
  `;
  const orgId = orgRows[0]!.id;

  await sql`
    INSERT INTO capacity (
      org_id, allocated_bytes, used_bytes, auto_enabled,
      increment_gb, threshold_pct, max_monthly_spend_cents, spend_this_cycle_cents
    ) VALUES (
      ${orgId},
      ${String(opts.allocatedBytes ?? gb(10))}::bigint,
      ${String(opts.usedBytes ?? 0n)}::bigint,
      ${opts.autoEnabled ?? false},
      ${opts.incrementGb ?? 10},
      ${opts.thresholdPct ?? 80},
      ${opts.maxMonthlySpendCents ?? 0},
      0
    )
  `;

  const bucketName = `itest-bucket-${unique}`;
  const minioBucket = buildMinioBucketName(orgId, bucketName);
  const bucketRows = await sql<{ id: string }[]>`
    INSERT INTO buckets (org_id, name, minio_bucket, versioning_enabled)
    VALUES (${orgId}, ${bucketName}, ${minioBucket}, false)
    RETURNING id
  `;
  const bucketId = bucketRows[0]!.id;

  return { orgId, slug, bucketId, bucketName, minioBucket };
}

export interface SeededPlanSub {
  planId: string;
  subscriptionId: string;
  stripeSubscriptionId: string;
}

/**
 * Seed a plan (with a stripe_addon_price_id so addCapacity proceeds) and an
 * active subscription whose current_period_end is `daysRemaining` days out, so
 * proration math has a real period to compute against.
 */
export async function seedPlanAndSubscription(
  sql: Sql,
  orgId: string,
  opts: {
    includedGb?: number;
    basePriceCents?: number;
    perGbPriceCents?: number;
    daysRemaining?: number;
  } = {},
): Promise<SeededPlanSub> {
  const tierKey = `itest-tier-${randomUUID().slice(0, 8)}`;
  const planRows = await sql<{ id: string }[]>`
    INSERT INTO plans (
      tier_key, name, included_gb, base_price_cents, per_gb_price_cents,
      stripe_product_id, stripe_price_id, stripe_addon_price_id
    ) VALUES (
      ${tierKey}, 'Integration Plan',
      ${opts.includedGb ?? 100},
      ${opts.basePriceCents ?? 900},
      ${opts.perGbPriceCents ?? 2},
      'prod_itest', 'price_itest_base', 'price_itest_addon'
    )
    RETURNING id
  `;
  const planId = planRows[0]!.id;

  const stripeSubscriptionId = `sub_itest_${randomUUID().slice(0, 12)}`;
  const daysRemaining = opts.daysRemaining ?? 15;
  const periodEnd = new Date(
    Date.now() + daysRemaining * 86_400_000,
  ).toISOString();

  const subRows = await sql<{ id: string }[]>`
    INSERT INTO subscriptions (
      org_id, stripe_subscription_id, stripe_customer_id, plan_id, status, current_period_end
    ) VALUES (
      ${orgId}, ${stripeSubscriptionId}, 'cus_itest', ${planId}, 'active', ${periodEnd}
    )
    RETURNING id
  `;

  return { planId, subscriptionId: subRows[0]!.id, stripeSubscriptionId };
}
