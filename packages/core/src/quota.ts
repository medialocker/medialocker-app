import type { Sql } from 'postgres';
import { gbToBytes } from './pricing.js';

export interface CapacityRow {
  allocated_bytes: bigint;
  used_bytes: bigint;
}

function bigintParam(v: bigint): string {
  return String(v);
}

export async function reserveCapacity(
  client: Sql,
  orgId: string,
  delta: bigint,
): Promise<{ success: boolean; newUsed: bigint }> {
  const rows = await (client as Sql)<{ used_bytes: bigint }[]>`
    UPDATE capacity
       SET used_bytes = used_bytes + ${bigintParam(delta)}::bigint
      WHERE org_id = ${orgId}
        AND used_bytes + ${bigintParam(delta)}::bigint <= allocated_bytes
    RETURNING used_bytes
  `;

  const row = rows[0];
  if (!row) {
    return { success: false, newUsed: BigInt(0) };
  }

  return { success: true, newUsed: row.used_bytes };
}

export async function releaseCapacity(
  client: Sql,
  orgId: string,
  size: bigint,
): Promise<void> {
  await (client as Sql)`
    UPDATE capacity
       SET used_bytes = GREATEST(0, used_bytes - ${bigintParam(size)}::bigint)
      WHERE org_id = ${orgId}
  `;
}

export async function reconcileCapacity(
  client: Sql,
  orgId: string,
  actualBytes: bigint,
  reservedBytes: bigint,
): Promise<void> {
  await (client as Sql)`
    UPDATE capacity
       SET used_bytes = used_bytes + (${bigintParam(actualBytes)}::bigint - ${bigintParam(reservedBytes)}::bigint)
      WHERE org_id = ${orgId}
  `;
}

export async function getCapacity(
  client: Sql,
  orgId: string,
): Promise<{
  allocatedBytes: bigint;
  usedBytes: bigint;
  freeBytes: bigint;
  usagePercent: number;
}> {
  const rows = await (client as Sql)<CapacityRow[]>`
    SELECT allocated_bytes, used_bytes
      FROM capacity
     WHERE org_id = ${orgId}
  `;

  const row = rows[0];
  if (!row) {
    return {
      allocatedBytes: BigInt(0),
      usedBytes: BigInt(0),
      freeBytes: BigInt(0),
      usagePercent: 0,
    };
  }

  const freeBytes = row.allocated_bytes - row.used_bytes;
  const usagePercent =
    row.allocated_bytes > BigInt(0)
      ? (Number(row.used_bytes) / Number(row.allocated_bytes)) * 100
      : 0;

  return {
    allocatedBytes: row.allocated_bytes,
    usedBytes: row.used_bytes,
    freeBytes: freeBytes > BigInt(0) ? freeBytes : BigInt(0),
    usagePercent,
  };
}

// NOTE: auto-capacity now lives in `@medialocker/billing` (`autoAddCapacity`) so
// that adding capacity always creates the Stripe add-on item + `billing_addons`
// row and respects max monthly spend (§8/§26). The previous pure-DB
// `tryAutoCapacity` here granted capacity without billing and was removed.

export async function canDowngrade(
  client: Sql,
  orgId: string,
  targetPlanId: string,
): Promise<{ allowed: boolean; reason?: string; excessGb?: number }> {
  const rows = await (client as Sql)<
    {
      included_gb: number;
      per_gb_price_cents: number;
      allocated_bytes: bigint;
      used_bytes: bigint;
    }[]
  >`
    SELECT p.included_gb,
           p.per_gb_price_cents,
           c.allocated_bytes,
           c.used_bytes
      FROM plans p
      CROSS JOIN capacity c
     WHERE p.id = ${targetPlanId}
       AND c.org_id = ${orgId}
  `;

  const row = rows[0];
  if (!row) {
    return { allowed: false, reason: 'Target plan or capacity not found' };
  }

  const targetAllocated = gbToBytes(row.included_gb);

  if (row.used_bytes > targetAllocated) {
    const excessBytes = row.used_bytes - targetAllocated;
    const excessGb = Math.ceil(Number(excessBytes) / 1_000_000_000);
    return {
      allowed: false,
      reason: `Current usage (${excessGb} GB) exceeds target plan capacity. Free up ${excessGb} GB first.`,
      excessGb,
    };
  }

  return { allowed: true };
}
