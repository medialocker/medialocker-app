import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';

export interface BucketResolution {
  orgId: string;
  bucketId: string;
  bucket: string;
}

export interface HostResolution {
  orgId: string;
  bucket: string;
}

/**
 * Acquire a Postgres transaction-level advisory lock keyed on an org ID.
 * Uses Postgres-native `hashtext` so every caller (API, billing, worker)
 * serializes on the same lock space. This replaces the previous split where
 * billing used a JS-side DJB2 hash and the API used `hashtext` — the two
 * lock-ID spaces never overlapped, so concurrent operations could race.
 *
 * Must be called inside a transaction (`sql.begin(...)`).
 */
export async function acquireOrgLock(
  tx: Sql | TransactionSql,
  orgId: string,
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`;
}

export async function resolveOrgFromBucket(
  client: Sql,
  bucketName: string,
): Promise<BucketResolution | null> {
  const rows = await client<{ org_id: string; id: string; name: string }[]>`
    SELECT b.id, b.org_id, b.name
      FROM buckets b
     WHERE b.name = ${bucketName}
  `;

  const row = rows[0];
  if (!row) return null;

  return { orgId: row.org_id, bucketId: row.id, bucket: row.name };
}

export async function resolveBucketFromHost(
  client: Sql,
  host: string,
  baseDomain: string,
): Promise<HostResolution | null> {
  const portIndex = host.indexOf(':');
  const hostname = portIndex !== -1 ? host.slice(0, portIndex) : host;
  const suffix = `.s3.${baseDomain}`;

  if (!hostname.endsWith(suffix)) return null;

  const bucketName = hostname.slice(0, -suffix.length);
  if (bucketName.length === 0) return null;

  const result = await resolveOrgFromBucket(client, bucketName);
  if (!result) return null;

  return { orgId: result.orgId, bucket: result.bucket };
}

/**
 * Deterministically derive the backing storage bucket name (Hetzner Object
 * Storage) for an org's logical bucket. Hash-prefixed so it is globally unique
 * within the single Hetzner project, and HARD-CAPPED at the S3 63-char limit
 * (`ml-` + readable slug + 12-char hash). This is the ONE canonical scheme — the
 * API control plane, the MCP server, and billing provisioning all call it so a
 * bucket created on any path resolves identically.
 *
 * Note: the value is persisted in `buckets.minio_bucket` (column rename deferred,
 * §10), so the data path always reads the stored value; this function is only
 * invoked at creation time.
 */
export function buildBucketName(orgId: string, bucketName: string): string {
  const hash = createHash('sha256')
    .update(`${orgId}\n${bucketName}`)
    .digest('hex')
    .slice(0, 12);
  const MAX_TOTAL = 63;
  const reserved = 'ml-'.length + hash.length + 2; // 17
  const slugMax = MAX_TOTAL - reserved;
  const slug = bucketName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, slugMax)
    .replace(/^-+|-+$/g, '');
  const middle = slug.length > 0 ? `${slug}-` : '';
  return `ml-${middle}${hash}`;
}

export function validateBucketName(name: string): { valid: boolean; reason?: string } {
  if (name.length < 3 || name.length > 63) {
    return { valid: false, reason: 'Bucket name must be between 3 and 63 characters' };
  }

  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) {
    return {
      valid: false,
      reason: 'Bucket name must start and end with a lowercase letter or number',
    };
  }

  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(name)) {
    return {
      valid: false,
      reason: 'Bucket name must contain only lowercase letters, numbers, and hyphens',
    };
  }

  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) {
    return { valid: false, reason: 'Bucket name must not be formatted as an IP address' };
  }

  if (name.startsWith('xn--')) {
    return { valid: false, reason: 'Bucket name must not start with xn--' };
  }

  return { valid: true };
}
