import postgres, { type Sql, type TransactionSql } from "postgres";
import { getConfig } from "@medialocker/config";

let _sql: Sql | null = null;

function getSql(): Sql {
  if (!_sql) {
    const config = getConfig();
    _sql = postgres(config.DATABASE_URL, {
      // Shared runtime client (also used by the worker). Sized for the Supabase
      // Cloud transaction pooler (port 6543): `prepare: false` because the pooler
      // multiplexes connections per-transaction and does not support prepared
      // statements. Runtime advisory locks are transaction-scoped
      // (pg_advisory_xact_lock), so they are pooler-safe. TLS comes from the
      // connection string (`?sslmode=require`).
      max: 10,
      idle_timeout: 30_000,
      connect_timeout: 10_000,
      prepare: false,
    });
  }
  return _sql;
}

export function sql(): Sql {
  return getSql();
}

export async function disconnect(): Promise<void> {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = null;
  }
}

export function createClient(): Sql {
  return getSql();
}

export type { Sql };
export * from "./types.js";

export async function getOrganizationById(
  id: string,
) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM organizations WHERE id = ${id} LIMIT 1`;
  return rows[0] ?? null;
}

export async function getOrganizationBySlug(slug: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM organizations WHERE slug = ${slug} LIMIT 1`;
  return rows[0] ?? null;
}

export async function createOrganization(name: string, slug: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO organizations (name, slug) VALUES (${name}, ${slug}) RETURNING *`;
  return rows[0]!;
}

export async function createUser(data: {
  id?: string;
  email: string;
  name?: string | null;
  avatar_url?: string | null;
}) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO users (id, email, name, avatar_url)
    VALUES (${data.id ?? null}, ${data.email}, ${data.name ?? null}, ${data.avatar_url ?? null})
    RETURNING *`;
  return rows[0]!;
}

export async function getUserById(id: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM users WHERE id = ${id} LIMIT 1`;
  return rows[0] ?? null;
}

export async function getUserByEmail(email: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM users WHERE email = ${email} LIMIT 1`;
  return rows[0] ?? null;
}

export async function getMembershipsForUser(userId: string) {
  return getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM memberships WHERE user_id = ${userId}`;
}

/**
 * Fetch the active (`current`) and immediately-previous version rows of a rotated
 * internal secret from the durable `service_secrets` store, newest first.
 *
 * Used by the internal-HMAC grace-window verifier (§5 secret-rotation loop): a
 * signature must verify under EITHER the current OR the previous secret so a
 * rotation does not break in-flight / clock-straddling service-to-service calls.
 * `value_enc` is AES-256-GCM ciphertext (decrypt via @medialocker/auth) — callers
 * MUST NOT log it. Returns at most two rows (the live one + one grace-window
 * predecessor); empty when the secret has never been rotated (caller falls back
 * to the env/config bootstrap value).
 */
export async function getServiceSecretVersions(name: string) {
  return getSql()<
    { version_id: string; value_enc: string; stages: string[]; created_at: Date }[]
  >`SELECT version_id, value_enc, stages, created_at
      FROM service_secrets
     WHERE name = ${name}
       AND ('current' = ANY(stages) OR 'previous' = ANY(stages))
     ORDER BY ('current' = ANY(stages)) DESC, created_at DESC
     LIMIT 2`;
}

export async function getMembershipsForOrg(orgId: string) {
  return getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM memberships WHERE org_id = ${orgId}`;
}

export async function createMembership(
  orgId: string,
  userId: string,
  role: string = "member",
) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO memberships (org_id, user_id, role)
    VALUES (${orgId}, ${userId}, ${role})
    RETURNING *`;
  return rows[0]!;
}

export async function getPlanByTier(tierKey: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM plans WHERE tier_key = ${tierKey} LIMIT 1`;
  return rows[0] ?? null;
}

export async function getAllPlans() {
  return getSql()<Record<string, unknown>[]>`SELECT * FROM plans ORDER BY included_gb ASC`;
}

export async function createPlan(data: {
  tier_key: string;
  name: string;
  included_gb: number;
  per_gb_price_cents: number;
  stripe_price_id?: string | null;
}) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO plans (tier_key, name, included_gb, per_gb_price_cents, stripe_price_id)
    VALUES (${data.tier_key}, ${data.name}, ${data.included_gb}, ${data.per_gb_price_cents}, ${data.stripe_price_id ?? null})
    RETURNING *`;
  return rows[0]!;
}

export async function getSubscriptionByOrg(orgId: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM subscriptions WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`;
  return rows[0] ?? null;
}

export async function createSubscription(data: {
  org_id: string;
  stripe_subscription_id: string;
  plan_id: string;
  status?: string;
  current_period_end: string;
}) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO subscriptions (org_id, stripe_subscription_id, plan_id, status, current_period_end)
    VALUES (${data.org_id}, ${data.stripe_subscription_id}, ${data.plan_id}, ${data.status ?? "active"}, ${data.current_period_end})
    RETURNING *`;
  return rows[0]!;
}

export async function updateSubscriptionStatus(id: string, status: string) {
  await getSql()`UPDATE subscriptions SET status = ${status} WHERE id = ${id}`;
}

export async function getCapacity(orgId: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM capacity WHERE org_id = ${orgId} LIMIT 1`;
  return rows[0] ?? null;
}

export async function upsertCapacity(
  orgId: string,
  data: {
    allocated_bytes?: number;
    used_bytes?: number;
    auto_enabled?: boolean;
    increment_gb?: number;
    threshold_pct?: number;
    max_monthly_spend_cents?: number | null;
    spend_this_cycle_cents?: number;
  },
) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO capacity (
      org_id, allocated_bytes, used_bytes, auto_enabled,
      increment_gb, threshold_pct, max_monthly_spend_cents, spend_this_cycle_cents
    ) VALUES (
      ${orgId},
      COALESCE(${data.allocated_bytes != null ? String(data.allocated_bytes) : null}::bigint,
        (SELECT (p.included_gb * 1000000000)::bigint FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.org_id = ${orgId} LIMIT 1)
      ),
      COALESCE(${data.used_bytes != null ? String(data.used_bytes) : null}::bigint,
        (SELECT COALESCE(SUM(o.size), 0) FROM objects o JOIN buckets b ON b.id = o.bucket_id WHERE b.org_id = ${orgId} AND o.deleted_at IS NULL)
      ),
      ${data.auto_enabled ?? false},
      ${data.increment_gb ?? 10},
      ${data.threshold_pct ?? 80},
      ${data.max_monthly_spend_cents ?? null},
      ${data.spend_this_cycle_cents ?? 0}
    )
    ON CONFLICT (org_id) DO UPDATE SET
      allocated_bytes = COALESCE(${data.allocated_bytes != null ? String(data.allocated_bytes) : null}::bigint, capacity.allocated_bytes),
      used_bytes = COALESCE(${data.used_bytes != null ? String(data.used_bytes) : null}::bigint, capacity.used_bytes),
      auto_enabled = COALESCE(${data.auto_enabled ?? null}, capacity.auto_enabled),
      increment_gb = COALESCE(${data.increment_gb ?? null}, capacity.increment_gb),
      threshold_pct = COALESCE(${data.threshold_pct ?? null}, capacity.threshold_pct),
      max_monthly_spend_cents = COALESCE(${data.max_monthly_spend_cents ?? null}, capacity.max_monthly_spend_cents),
      spend_this_cycle_cents = COALESCE(${data.spend_this_cycle_cents ?? null}, capacity.spend_this_cycle_cents)
    RETURNING *`;
  return rows[0]!;
}

export async function createBillingAddon(orgId: string, stripeItemId: string, gb: number, costCents: number, prorated = false) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO billing_addons (org_id, stripe_item_id, gb, cost_cents, prorated)
    VALUES (${orgId}, ${stripeItemId}, ${gb}, ${costCents}, ${prorated})
    RETURNING *`;
  return rows[0]!;
}

export async function createBucket(
  orgId: string,
  name: string,
  minioBucket: string,
  versioningEnabled = false,
) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO buckets (org_id, name, minio_bucket, versioning_enabled)
    VALUES (${orgId}, ${name}, ${minioBucket}, ${versioningEnabled})
    RETURNING *`;
  return rows[0]!;
}

export async function getBucketById(id: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM buckets WHERE id = ${id} AND deleted_at IS NULL LIMIT 1`;
  return rows[0] ?? null;
}

export async function getBucketsByOrg(orgId: string) {
  return getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM buckets WHERE org_id = ${orgId} AND deleted_at IS NULL`;
}

export async function getBucketByName(orgId: string, name: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM buckets WHERE org_id = ${orgId} AND name = ${name} AND deleted_at IS NULL LIMIT 1`;
  return rows[0] ?? null;
}

export async function createObject(data: {
  bucket_id: string;
  key: string;
  version_id?: string | null;
  size?: number;
  etag?: string | null;
  content_type?: string | null;
  storage_class?: string;
}) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO objects (bucket_id, key, version_id, size, etag, content_type, storage_class)
    VALUES (${data.bucket_id}, ${data.key}, ${data.version_id ?? null}, ${data.size ?? 0}, ${data.etag ?? null}, ${data.content_type ?? null}, ${data.storage_class ?? "STANDARD"})
    ON CONFLICT (bucket_id, key) WHERE deleted_at IS NULL
    DO UPDATE SET
      version_id = EXCLUDED.version_id,
      size = EXCLUDED.size,
      etag = EXCLUDED.etag,
      content_type = EXCLUDED.content_type,
      storage_class = EXCLUDED.storage_class,
      updated_at = now()
    RETURNING *`;
  return rows[0]!;
}

export async function getObjectById(id: string, orgId: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`SELECT o.* FROM objects o
     JOIN buckets b ON b.id = o.bucket_id
     WHERE o.id = ${id} AND o.deleted_at IS NULL AND b.org_id = ${orgId}
     LIMIT 1`;
  return rows[0] ?? null;
}

export async function getObjectByKey(bucketId: string, key: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM objects WHERE bucket_id = ${bucketId} AND key = ${key} AND deleted_at IS NULL LIMIT 1`;
  return rows[0] ?? null;
}

/** @deprecated Use deleteObjectAndReleaseCapacity() instead — this does NOT release capacity. */
export async function softDeleteObject(id: string) {
  await getSql()`
    UPDATE objects SET deleted_at = now(), updated_at = now()
    WHERE id = ${id} AND deleted_at IS NULL
  `;
}

export async function deleteObjectAndReleaseCapacity(objectId: string, orgId: string) {
  await getSql().begin(async (tx) => {
    const rows = await tx<{ size: bigint }[]>`
      SELECT size FROM objects WHERE id = ${objectId} AND deleted_at IS NULL LIMIT 1
    `;
    if (rows.length === 0) return;
    const size = rows[0]!.size;
    await tx`UPDATE objects SET deleted_at = now(), updated_at = now() WHERE id = ${objectId}`;
    // P2.46: the object is SOFT-deleted (row kept, deleted_at set), so the
    // derivatives FK's ON DELETE CASCADE never fires. Explicitly remove the
    // derivative rows inside the same transaction so a soft-deleted object does
    // not leave orphaned derivatives behind (the worker reclaims the MinIO keys
    // separately). Done before capacity math so it is part of the same atomic unit.
    await tx`DELETE FROM derivatives WHERE object_id = ${objectId}`;
    if (size > 0n) {
      await tx`UPDATE capacity SET used_bytes = GREATEST(0, used_bytes - ${String(size)}::bigint) WHERE org_id = ${orgId}`;
      await tx`INSERT INTO usage_events (org_id, type, bytes, ts) VALUES (${orgId}, 'stored_delta', ${String(-size)}::bigint, now())`;
    }
  });
}

export async function getObjectsByBucket(bucketId: string, limit = 100, offset = 0) {
  return getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM objects WHERE bucket_id = ${bucketId} AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
}

export async function setObjectUserMetadata(
  objectId: string,
  key: string,
  value: string,
) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO object_user_metadata (object_id, key, value) VALUES (${objectId}, ${key}, ${value}) ON CONFLICT (object_id, key) DO UPDATE SET value = ${value} RETURNING *`;
  return rows[0]!;
}

export async function getObjectUserMetadata(objectId: string) {
  return getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM object_user_metadata WHERE object_id = ${objectId}`;
}

export async function insertApiKey(data: {
  org_id: string;
  access_key_id: string;
  secret_enc: string;
  bearer_lookup_hash: string;
  name?: string | null;
  scopes?: string[];
  bucket_scope?: string | null;
  expires_at?: string;
}) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO api_keys (org_id, access_key_id, secret_enc, bearer_lookup_hash, name, scopes, bucket_scope, expires_at)
    VALUES (${data.org_id}, ${data.access_key_id}, ${data.secret_enc}, ${data.bearer_lookup_hash}, ${data.name ?? null}, ${data.scopes ?? []}, ${data.bucket_scope ?? null}, ${data.expires_at ?? null})
    RETURNING *`;
  return rows[0]!;
}

export async function getApiKeyByAccessKeyId(accessKeyId: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM api_keys WHERE access_key_id = ${accessKeyId} AND revoked_at IS NULL AND expires_at > now() LIMIT 1`;
  return rows[0] ?? null;
}

export async function getApiKeyByBearerHash(hash: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM api_keys WHERE bearer_lookup_hash = ${hash} AND revoked_at IS NULL AND expires_at > now() LIMIT 1`;
  return rows[0] ?? null;
}

export async function revokeApiKey(id: string) {
  await getSql()`UPDATE api_keys SET revoked_at = now() WHERE id = ${id}`;
}

export async function updateApiKeyLastUsed(id: string) {
  await getSql()`UPDATE api_keys SET last_used_at = now() WHERE id = ${id}`;
}

/**
 * Insert (or, on re-probe / object overwrite, update) the media_assets row for
 * an object. `object_id` is the UNIQUE key on media_assets (001), so re-probing
 * the same object upserts rather than erroring (P2.45): ON CONFLICT (object_id)
 * DO UPDATE refreshes every probe-derived column with the latest values.
 */
export async function createMediaAsset(data: {
  object_id: string;
  kind?: string;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  codec?: string | null;
  frame_rate?: number | null;
  has_audio?: boolean | null;
  probe_json?: Record<string, unknown> | null;
}) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO media_assets (object_id, kind, width, height, duration_ms, codec, frame_rate, has_audio, probe_json)
    VALUES (${data.object_id}, ${data.kind ?? "other"}, ${data.width ?? null}, ${data.height ?? null}, ${data.duration_ms ?? null}, ${data.codec ?? null}, ${data.frame_rate ?? null}, ${data.has_audio ?? null}, ${data.probe_json ? JSON.stringify(data.probe_json) : null})
    ON CONFLICT (object_id) DO UPDATE SET
      kind = EXCLUDED.kind,
      width = EXCLUDED.width,
      height = EXCLUDED.height,
      duration_ms = EXCLUDED.duration_ms,
      codec = EXCLUDED.codec,
      frame_rate = EXCLUDED.frame_rate,
      has_audio = EXCLUDED.has_audio,
      probe_json = EXCLUDED.probe_json
    RETURNING *`;
  return rows[0]!;
}

export async function getMediaAssetByObjectId(objectId: string, orgId: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`SELECT ma.* FROM media_assets ma
     JOIN objects o ON o.id = ma.object_id
     JOIN buckets b ON b.id = o.bucket_id
     WHERE ma.object_id = ${objectId} AND b.org_id = ${orgId}
     LIMIT 1`;
  return rows[0] ?? null;
}

export async function createTag(orgId: string, name: string, slug: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO tags (org_id, name, slug) VALUES (${orgId}, ${name}, ${slug}) RETURNING *`;
  return rows[0]!;
}

export async function getTagsByOrg(orgId: string) {
  return getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM tags WHERE org_id = ${orgId} ORDER BY name ASC`;
}

export async function findTagBySlug(orgId: string, slug: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM tags WHERE org_id = ${orgId} AND slug = ${slug} LIMIT 1`;
  return rows[0] ?? null;
}

export async function addObjectTag(objectId: string, tagId: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO object_tags (object_id, tag_id) VALUES (${objectId}, ${tagId}) ON CONFLICT (object_id, tag_id) DO NOTHING RETURNING *`;
  return rows[0] ?? null;
}

export async function removeObjectTag(objectId: string, tagId: string) {
  await getSql()`DELETE FROM object_tags WHERE object_id = ${objectId} AND tag_id = ${tagId}`;
}

export async function getTagsForObject(objectId: string, orgId: string) {
  return getSql()<
    Record<string, unknown>[]
  >`SELECT t.* FROM tags t
     JOIN object_tags ot ON t.id = ot.tag_id
     JOIN objects o ON o.id = ot.object_id
     JOIN buckets b ON b.id = o.bucket_id
     WHERE ot.object_id = ${objectId} AND b.org_id = ${orgId}`;
}

export async function createCategory(
  orgId: string,
  name: string,
  slug: string,
  parentId?: string | null,
) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO categories (org_id, name, slug, parent_id) VALUES (${orgId}, ${name}, ${slug}, ${parentId ?? null}) RETURNING *`;
  return rows[0]!;
}

export async function getCategoriesByOrg(orgId: string) {
  return getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM categories WHERE org_id = ${orgId} ORDER BY name ASC`;
}

export async function addObjectCategory(objectId: string, categoryId: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO object_categories (object_id, category_id) VALUES (${objectId}, ${categoryId}) ON CONFLICT (object_id, category_id) DO NOTHING RETURNING *`;
  return rows[0] ?? null;
}

export async function removeObjectCategory(objectId: string, categoryId: string) {
  await getSql()`DELETE FROM object_categories WHERE object_id = ${objectId} AND category_id = ${categoryId}`;
}

export async function createSet(orgId: string, name: string, baseObjectId?: string | null) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO sets (org_id, name, base_object_id) VALUES (${orgId}, ${name}, ${baseObjectId ?? null}) RETURNING *`;
  return rows[0]!;
}

export async function getSetsByOrg(orgId: string) {
  return getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM sets WHERE org_id = ${orgId} ORDER BY created_at DESC`;
}

export async function addSetItem(
  setId: string,
  objectId: string,
  aspectRatio?: string | null,
  width?: number | null,
  height?: number | null,
  role?: string | null,
) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO set_items (set_id, object_id, aspect_ratio, width, height, role)
    VALUES (${setId}, ${objectId}, ${aspectRatio ?? null}, ${width ?? null}, ${height ?? null}, ${role ?? null})
    ON CONFLICT (set_id, object_id) DO UPDATE SET
      aspect_ratio = COALESCE(${aspectRatio ?? null}, set_items.aspect_ratio),
      width = COALESCE(${width ?? null}, set_items.width),
      height = COALESCE(${height ?? null}, set_items.height),
      role = COALESCE(${role ?? null}, set_items.role)
    RETURNING *`;
  return rows[0]!;
}

export async function getSetItems(setId: string) {
  return getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM set_items WHERE set_id = ${setId} ORDER BY object_id`;
}

export async function createStoryboard(orgId: string, name: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO storyboards (org_id, name) VALUES (${orgId}, ${name}) RETURNING *`;
  return rows[0]!;
}

export async function getStoryboardsByOrg(orgId: string) {
  return getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM storyboards WHERE org_id = ${orgId} ORDER BY created_at DESC`;
}

export async function addStoryboardClip(
  storyboardId: string,
  objectId: string,
  position: number,
  note?: string | null,
) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO storyboard_clips (storyboard_id, object_id, position, note)
    VALUES (${storyboardId}, ${objectId}, ${position}, ${note ?? null})
    ON CONFLICT (storyboard_id, position) DO UPDATE SET
      object_id = ${objectId},
      note = COALESCE(${note ?? null}, storyboard_clips.note)
    RETURNING *`;
  return rows[0]!;
}

export async function getStoryboardClips(storyboardId: string) {
  return getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM storyboard_clips WHERE storyboard_id = ${storyboardId} ORDER BY position ASC`;
}

export async function createDerivative(data: {
  object_id: string;
  type: string;
  minio_key: string;
  width?: number | null;
  height?: number | null;
  bytes?: number;
  billable?: boolean;
}) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO derivatives (object_id, type, minio_key, width, height, bytes, billable)
    VALUES (${data.object_id}, ${data.type}, ${data.minio_key}, ${data.width ?? null}, ${data.height ?? null}, ${data.bytes ?? 0}, ${data.billable ?? false})
    RETURNING *`;
  return rows[0]!;
}

export async function getDerivativesForObject(objectId: string, orgId: string) {
  return getSql()<
    Record<string, unknown>[]
  >`SELECT d.* FROM derivatives d
     JOIN objects o ON o.id = d.object_id
     JOIN buckets b ON b.id = o.bucket_id
     WHERE d.object_id = ${objectId} AND b.org_id = ${orgId}`;
}

export async function upsertSearchIndex(objectId: string, tsvRaw: string, language = 'english') {
  const s = getSql();
  const rows = await s.unsafe(
    `INSERT INTO search_index (object_id, tsv)
     VALUES ($1, to_tsvector($2, $3))
     ON CONFLICT (object_id) DO UPDATE SET tsv = EXCLUDED.tsv
     RETURNING *`,
    [objectId, language, tsvRaw],
  ) as unknown as Record<string, unknown>[];
  return rows[0]!;
}

export async function searchObjects(query: string, orgId: string, limit = 50, offset = 0, language = 'english') {
  return getSql()<
    Record<string, unknown>[]
  >`SELECT o.* FROM objects o
     JOIN search_index si ON o.id = si.object_id
     JOIN buckets b ON o.bucket_id = b.id
     WHERE b.org_id = ${orgId}
       AND o.deleted_at IS NULL
       AND si.tsv @@ plainto_tsquery(${language}, ${query})
     ORDER BY ts_rank(si.tsv, plainto_tsquery(${language}, ${query})) DESC
     LIMIT ${limit} OFFSET ${offset}`;
}

export async function insertUsageEvent(orgId: string, type: string, bytes: number) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO usage_events (org_id, type, bytes) VALUES (${orgId}, ${type}, ${bytes}) RETURNING *`;
  return rows[0]!;
}

export async function getUsageEventsForOrg(orgId: string, since: string) {
  return getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM usage_events WHERE org_id = ${orgId} AND ts >= ${since} ORDER BY ts DESC`;
}

export async function upsertUsageRollup(
  orgId: string,
  period: string,
  storedBytesMax = 0,
  egressBytes = 0,
  requestCount = 0,
) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO usage_rollups (org_id, period, stored_bytes_max, egress_bytes, request_count)
    VALUES (${orgId}, ${period}, ${storedBytesMax}, ${egressBytes}, ${requestCount})
    ON CONFLICT (org_id, period) DO UPDATE SET
      stored_bytes_max = ${storedBytesMax},
      egress_bytes = ${egressBytes},
      request_count = ${requestCount}
    RETURNING *`;
  return rows[0]!;
}

export async function getUsageRollup(orgId: string, period: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM usage_rollups WHERE org_id = ${orgId} AND period = ${period} LIMIT 1`;
  return rows[0] ?? null;
}

export async function insertAuditLog(
  orgId: string,
  actor: string,
  action: string,
  target: string,
  ip?: string | null,
) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO audit_log (org_id, actor, action, target, ip)
    VALUES (${orgId}, ${actor}, ${action}, ${target}, ${ip ?? null})
    RETURNING *`;
  return rows[0]!;
}

export async function getAuditLogs(orgId: string, limit = 100, offset = 0) {
  return getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM audit_log WHERE org_id = ${orgId} ORDER BY ts DESC LIMIT ${limit} OFFSET ${offset}`;
}

/**
 * Retention trim for the unpartitioned `usage_events` time-series table (P2.49).
 * Deletes rows older than `retainDays` in batches (each call of the SQL
 * `cleanup_old_usage_events` function from migration 009 deletes up to
 * `batchLimit` rows) until none remain, so a single invocation never holds a
 * giant delete in one statement. Returns the total number of rows deleted.
 *
 * Backed by `idx_usage_events_org_ts_id` (migration 009) for the cutoff scan.
 */
export async function trimUsageEventsOlderThan(
  retainDays = 90,
  batchLimit = 5000,
): Promise<bigint> {
  let total = 0n;
  for (;;) {
    const rows = await getSql()<{ deleted: bigint }[]>`
      SELECT cleanup_old_usage_events(${retainDays}, ${batchLimit}) AS deleted
    `;
    const deleted = rows[0]?.deleted ?? 0n;
    total += deleted;
    if (deleted < BigInt(batchLimit)) break;
  }
  return total;
}

/**
 * Retention trim for the unpartitioned `audit_log` time-series table (P2.49).
 * Same batched strategy as `trimUsageEventsOlderThan`, calling the
 * `cleanup_old_audit_logs` function from migration 009. Audit retention defaults
 * to a longer window (365 days) than usage events. Returns total rows deleted.
 *
 * Backed by `idx_audit_log_org_ts_id` (migration 009) for the cutoff scan.
 */
export async function trimAuditLogOlderThan(
  retainDays = 365,
  batchLimit = 5000,
): Promise<bigint> {
  let total = 0n;
  for (;;) {
    const rows = await getSql()<{ deleted: bigint }[]>`
      SELECT cleanup_old_audit_logs(${retainDays}, ${batchLimit}) AS deleted
    `;
    const deleted = rows[0]?.deleted ?? 0n;
    total += deleted;
    if (deleted < BigInt(batchLimit)) break;
  }
  return total;
}

/**
 * Atomically reserve capacity bytes for an org.
 * Returns { success, newUsedBytes } - success is false if quota would be exceeded.
 * Advisory-locked per org to prevent concurrent reservation races.
 */
export async function reserveCapacity(
  sql: Sql | TransactionSql,
  orgId: string,
  delta: bigint,
): Promise<{ success: boolean; newUsedBytes: bigint }> {
  const rows = await sql<{ used_bytes: bigint; allocated_bytes: bigint }[]>`
    SELECT used_bytes, allocated_bytes FROM capacity WHERE org_id = ${orgId} FOR UPDATE
  `;
  if (rows.length === 0) return { success: false, newUsedBytes: 0n };
  const cap = rows[0]!;
  const newUsed = cap.used_bytes + delta;
  if (newUsed < 0n) return { success: false, newUsedBytes: cap.used_bytes };
  if (delta > 0n && newUsed > cap.allocated_bytes) {
    return { success: false, newUsedBytes: cap.used_bytes };
  }
  await sql`UPDATE capacity SET used_bytes = ${String(newUsed)}::bigint WHERE org_id = ${orgId}`;
  return { success: true, newUsedBytes: newUsed };
}

/**
 * Release capacity bytes for an org (delta must be positive - amount to release).
 */
export async function releaseCapacity(
  sql: Sql | TransactionSql,
  orgId: string,
  delta: bigint,
): Promise<{ newUsedBytes: bigint }> {
  const rows = await sql<{ used_bytes: bigint }[]>`
    UPDATE capacity SET used_bytes = GREATEST(0, used_bytes - ${String(delta)}::bigint)
    WHERE org_id = ${orgId}
    RETURNING used_bytes
  `;
  return { newUsedBytes: rows[0]?.used_bytes ?? 0n };
}

export async function createMultipartUpload(data: {
  upload_id: string;
  bucket_id: string;
  key: string;
  total_bytes_reserved: bigint;
  content_type: string;
}) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO multipart_uploads (upload_id, bucket_id, key, total_bytes_reserved, content_type, created_at)
    VALUES (${data.upload_id}, ${data.bucket_id}, ${data.key}, ${String(data.total_bytes_reserved)}::bigint, ${data.content_type}, NOW())
    RETURNING *`;
  return rows[0]!;
}

export async function getMultipartUpload(uploadId: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM multipart_uploads WHERE upload_id = ${uploadId} LIMIT 1`;
  return rows[0] ?? null;
}

export async function addMultipartPart(data: {
  upload_id: string;
  part_number: number;
  etag: string;
  size: bigint;
}) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`INSERT INTO multipart_parts (upload_id, part_number, etag, size)
    VALUES (${data.upload_id}, ${data.part_number}, ${data.etag}, ${String(data.size)}::bigint)
    ON CONFLICT (upload_id, part_number) DO UPDATE SET etag = ${data.etag}, size = ${String(data.size)}::bigint
    RETURNING *`;
  return rows[0]!;
}

export async function listParts(uploadId: string) {
  return getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM multipart_parts WHERE upload_id = ${uploadId} ORDER BY part_number`;
}

/**
 * Abort a multipart upload: delete its parts + the upload row and release any
 * capacity that was reserved for it, all inside a single transaction so a
 * partial failure can never leave parts/uploads orphaned or capacity leaked
 * (P2.44).
 *
 * Capacity is released by `total_bytes_reserved` against the owning org (reached
 * through the upload's bucket). If the upload row is already gone the call is a
 * no-op.
 */
export async function abortMultipartUpload(uploadId: string) {
  await getSql().begin(async (tx) => {
    const rows = await tx<
      { total_bytes_reserved: bigint; org_id: string | null }[]
    >`
      SELECT mu.total_bytes_reserved, b.org_id
        FROM multipart_uploads mu
        LEFT JOIN buckets b ON b.id = mu.bucket_id
       WHERE mu.upload_id = ${uploadId}
       FOR UPDATE OF mu
    `;
    if (rows.length === 0) return;

    const { total_bytes_reserved, org_id } = rows[0]!;

    await tx`DELETE FROM multipart_parts WHERE upload_id = ${uploadId}`;
    await tx`DELETE FROM multipart_uploads WHERE upload_id = ${uploadId}`;

    if (org_id != null && total_bytes_reserved > 0n) {
      await releaseCapacity(tx, org_id, total_bytes_reserved);
    }
  });
}

/**
 * Return multipart uploads (and their parts) older than `olderThan` so a worker
 * can abort the corresponding MinIO multipart uploads and reclaim storage
 * (P2.43). This is read-only: it does NOT delete anything — deletion is left to
 * the worker (or to the SQL `cleanup_expired_multipart_uploads()` function from
 * migration 008) once the MinIO side has been cleaned, so we never drop DB state
 * for an upload whose object store cleanup has not yet succeeded.
 *
 * Backed by `idx_multipart_uploads_created_at` (migration 010).
 *
 * @param olderThan cutoff — uploads created strictly before this are returned.
 */
export async function cleanupExpiredMultipartUploads(olderThan: Date): Promise<
  {
    upload_id: string;
    bucket_id: string | null;
    key: string;
    total_bytes_reserved: bigint;
    created_at: Date;
    parts: { part_number: number; etag: string; size: bigint }[];
  }[]
> {
  const uploads = await getSql()<
    {
      upload_id: string;
      bucket_id: string | null;
      key: string;
      total_bytes_reserved: bigint;
      created_at: Date;
    }[]
  >`
    SELECT upload_id, bucket_id, key, total_bytes_reserved, created_at
      FROM multipart_uploads
     WHERE created_at < ${olderThan}
     ORDER BY created_at ASC
  `;

  if (uploads.length === 0) return [];

  const uploadIds = uploads.map((u) => u.upload_id);
  const parts = await getSql()<
    { upload_id: string; part_number: number; etag: string; size: bigint }[]
  >`
    SELECT upload_id, part_number, etag, size
      FROM multipart_parts
     WHERE upload_id = ANY(${uploadIds})
     ORDER BY upload_id, part_number
  `;

  const partsByUpload = new Map<
    string,
    { part_number: number; etag: string; size: bigint }[]
  >();
  for (const p of parts) {
    const list = partsByUpload.get(p.upload_id) ?? [];
    list.push({ part_number: p.part_number, etag: p.etag, size: p.size });
    partsByUpload.set(p.upload_id, list);
  }

  return uploads.map((u) => ({
    ...u,
    parts: partsByUpload.get(u.upload_id) ?? [],
  }));
}

export async function getApiKeysByOrg(orgId: string) {
  return getSql()<
    Record<string, unknown>[]
  >`SELECT * FROM api_keys WHERE org_id = ${orgId} AND revoked_at IS NULL ORDER BY created_at DESC`;
}

export async function revokeApiKeyForOrg(orgId: string, keyId: string) {
  const rows = await getSql()<
    Record<string, unknown>[]
  >`UPDATE api_keys SET revoked_at = now() WHERE id = ${keyId} AND org_id = ${orgId} RETURNING id`;
  return rows.length > 0;
}
