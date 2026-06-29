import type { Job } from 'bullmq';
import { z } from 'zod';
import {
  RotationManager,
  PollingPropagationVerifier,
  type RotationResult,
} from '@reaatech/secret-rotation-core';
import type {
  SecretProvider,
  SecretValue,
  SecretVersion,
  RotationSession,
  ProviderHealth,
  ProviderCapabilities,
  DeleteOptions,
  Logger as RotationLogger,
  KeyStore,
  SecretKey,
} from '@reaatech/secret-rotation-types';
import { getConfig } from '@medialocker/config';
import { encrypt, decrypt } from '@medialocker/auth';
import { getDb } from '../db';
import { logger } from '../logger';

/**
 * Secret rotation worker job.
 *
 * Integrates `@reaatech/secret-rotation-core` to orchestrate the rotation
 * lifecycle (generate -> propagate -> verify -> activate -> revoke) for the
 * internal secrets MediaLocker controls:
 *
 *   - The internal signing / shared-secret material (`internal-api-secret`)
 *
 * (Hetzner Object Storage uses a single master credential rotated by env-swap +
 * restart, so storage credentials are no longer rotated through this engine.)
 *
 * The rotation engine is provider-driven: each secret is pushed through a
 * `SecretProvider` adapter. The provider below
 * ({@link PostgresControlledSecretProvider}) is REAL, not a stub — it performs
 * durable backing-store mutation against the `service_secrets` table:
 *   - it bootstraps current values from `@medialocker/config` (never
 *     `process.env`) on first run,
 *   - it persists each new version AES-256-GCM **encrypted** (plaintext never
 *     hits the DB or the logs) with `current`/`pending`/`previous` stages,
 *   - it promotes/demotes/rolls back versions and records an `audit_log` entry.
 *
 * CONSUMPTION (§5, now wired): the internal-HMAC verifier resolves its live
 * secret from this store with the env/config value as bootstrap/fallback — see
 * `@medialocker/auth#verifyInternalRequest`. `internal-api-secret` has no
 * external system to provision, so it promotes immediately on rotation.
 */

/** Logical names of the internal secrets MediaLocker rotates. */
const ROTATABLE_SECRETS = ['internal-api-secret'] as const;

type RotatableSecret = (typeof ROTATABLE_SECRETS)[number];

export interface SecretRotationJobData {
  type: 'scheduled' | 'manual';
  /** Optional explicit subset to rotate; defaults to all due secrets. */
  secrets?: RotatableSecret[];
}

/**
 * Adapt the worker's structured logger to the rotation kit's `Logger` shape
 * (the kit expects `(message, meta)`, the worker uses `(meta, message)`).
 */
const rotationLogger: RotationLogger = {
  debug: (message, meta) => logger.debug({ ...(meta ?? {}) }, message),
  info: (message, meta) => logger.info({ ...(meta ?? {}) }, message),
  warn: (message, meta) => logger.warn({ ...(meta ?? {}) }, message),
  error: (message, meta) => logger.error({ ...(meta ?? {}) }, message),
};

/**
 * Read the current live value of a controlled secret from validated config.
 * This is the single source of truth — app code never touches `process.env`.
 */
function readCurrentSecret(name: RotatableSecret): string {
  const cfg = getConfig();
  switch (name) {
    case 'internal-api-secret':
      return cfg.INTERNAL_API_SECRET;
  }
}

interface ServiceSecretRow {
  version_id: string;
  value_enc: string;
  stages: string[];
  created_at: Date;
}

/**
 * Postgres-backed provider adapter for MediaLocker-controlled secrets.
 *
 * Implements the `SecretProvider` contract from `@reaatech/secret-rotation-types`
 * so the core `RotationManager` drives the full lifecycle, and performs the REAL
 * backing-store mutation against the durable `service_secrets` table:
 *   - every value is stored AES-256-GCM **encrypted** (via `@medialocker/auth`,
 *     keyed by `API_KEY_ENC_KEY`) — plaintext never hits the DB or the logs,
 *   - versions are tracked with `stages` (`current` / `pending` / `previous`),
 *   - `completeRotation` promotes `pending`→`current` and demotes the old
 *     `current`→`previous`; `cancelRotation` deletes the un-activated `pending`
 *     version (a real rollback).
 *
 * This is the canonical record of rotated internal secrets for the self-hosted
 * deployment. Config (`@medialocker/config`) supplies only the one-time
 * bootstrap value via {@link ensureBootstrap}; thereafter this table is
 * authoritative. (A managed-secret-store provider — AWS/GCP/Vercel — can be
 * swapped in per §5 by replacing this class; the orchestration is unchanged.)
 */
export class PostgresControlledSecretProvider implements SecretProvider {
  public readonly name = 'medialocker-postgres';
  public readonly priority = 100;

  private readonly auditRotation: (
    secretName: string,
    newVersionId: string,
  ) => Promise<void>;

  constructor(
    auditRotation: (secretName: string, newVersionId: string) => Promise<void>,
  ) {
    this.auditRotation = auditRotation;
  }

  /**
   * Seed each controlled secret's `current` version from validated config the
   * first time it is rotated, so there is a previous value to overlap with.
   * Idempotent: only inserts when the secret has no rows yet. Not audited (it
   * records the pre-existing value, it is not a rotation event).
   */
  async ensureBootstrap(): Promise<void> {
    const db = getDb();
    for (const name of ROTATABLE_SECRETS) {
      const existing = await db`
        SELECT 1 FROM service_secrets WHERE name = ${name} LIMIT 1
      `;
      if (existing.length === 0) {
        await this.persist(name, readCurrentSecret(name), 'current', 'bootstrap', false);
      }
    }
  }

  /** Encrypt + write a new version, demoting any prior `current` to `previous`
   * when storing a new `current`. Optionally records an audit entry. */
  private async persist(
    name: string,
    value: string,
    stage: 'current' | 'pending',
    versionId: string,
    audit: boolean,
  ): Promise<SecretValue> {
    const db = getDb();
    const valueEnc = encrypt(value);

    if (stage === 'current') {
      await db`
        UPDATE service_secrets
           SET stages = array_append(array_remove(stages, 'current'), 'previous')
         WHERE name = ${name} AND 'current' = ANY(stages)
      `;
    }

    await db`
      INSERT INTO service_secrets (name, version_id, value_enc, stages)
      VALUES (${name}, ${versionId}, ${valueEnc}, ${[stage]})
      ON CONFLICT (name, version_id)
      DO UPDATE SET value_enc = EXCLUDED.value_enc, stages = EXCLUDED.stages
    `;

    // Never log the secret VALUE — only its name/version/stage.
    logger.info(
      { secret: name, versionId, stage },
      'Secret rotation: new encrypted version persisted',
    );
    if (audit) await this.auditRotation(name, versionId);

    return { value, versionId, versionStages: [stage], createdAt: new Date() };
  }

  async createSecret(name: string, value: string): Promise<void> {
    await this.persist(name, value, 'current', `v-${Date.now()}`, false);
  }

  async getSecret(name: string, version?: string): Promise<SecretValue> {
    const db = getDb();
    const rows = version
      ? await db<ServiceSecretRow[]>`
          SELECT version_id, value_enc, stages, created_at
            FROM service_secrets
           WHERE name = ${name} AND version_id = ${version}
           LIMIT 1`
      : await db<ServiceSecretRow[]>`
          SELECT version_id, value_enc, stages, created_at
            FROM service_secrets
           WHERE name = ${name} AND 'current' = ANY(stages)
           ORDER BY created_at DESC
           LIMIT 1`;
    const row = rows[0];
    if (!row) {
      throw new Error(`secret ${name} not found`);
    }
    return {
      value: decrypt(row.value_enc),
      versionId: row.version_id,
      versionStages: row.stages,
      createdAt: row.created_at,
    };
  }

  async storeSecretValue(
    name: string,
    value: string,
    options?: { stage?: 'current' | 'pending' },
  ): Promise<SecretValue> {
    const stage = options?.stage ?? 'current';
    return this.persist(name, value, stage, `v-${Date.now()}`, true);
  }

  async deleteSecret(name: string, _options?: DeleteOptions): Promise<void> {
    const db = getDb();
    await db`DELETE FROM service_secrets WHERE name = ${name}`;
  }

  async listVersions(name: string): Promise<SecretVersion[]> {
    const db = getDb();
    const rows = await db<ServiceSecretRow[]>`
      SELECT version_id, value_enc, stages, created_at
        FROM service_secrets
       WHERE name = ${name}
       ORDER BY created_at ASC
    `;
    return rows.map((r) => ({
      versionId: r.version_id,
      createdAt: r.created_at,
      stages: r.stages,
    }));
  }

  async getVersion(name: string, versionId: string): Promise<SecretValue> {
    return this.getSecret(name, versionId);
  }

  async deleteVersion(name: string, versionId: string): Promise<void> {
    const db = getDb();
    await db`DELETE FROM service_secrets WHERE name = ${name} AND version_id = ${versionId}`;
  }

  supportsRotation(): boolean {
    return true;
  }

  async beginRotation(name: string): Promise<RotationSession> {
    return {
      sessionId: `session-${name}-${Date.now()}`,
      secretName: name,
      provider: this.name,
      state: {},
      startedAt: new Date(),
    };
  }

  async completeRotation(session: RotationSession): Promise<void> {
    // `internal-api-secret` has no external system to provision, so the new
    // version promotes immediately (demote prior current → previous, promote
    // pending → current).
    await this.promote(session.secretName);
  }

  /** Demote the prior current → previous, then promote pending → current. */
  private async promote(name: string): Promise<void> {
    const db = getDb();
    await db`
      UPDATE service_secrets
         SET stages = array_append(array_remove(stages, 'current'), 'previous')
       WHERE name = ${name}
         AND 'current' = ANY(stages)
         AND NOT ('pending' = ANY(stages))
    `;
    await db`
      UPDATE service_secrets
         SET stages = array_append(array_remove(stages, 'pending'), 'current')
       WHERE name = ${name} AND 'pending' = ANY(stages)
    `;
  }

  async cancelRotation(session: RotationSession): Promise<void> {
    // Real rollback: drop the un-activated pending version.
    const db = getDb();
    await db`
      DELETE FROM service_secrets
       WHERE name = ${session.secretName} AND 'pending' = ANY(stages)
    `;
  }

  async health(): Promise<ProviderHealth> {
    return { status: 'healthy', latency: 0, lastChecked: new Date() };
  }

  capabilities(): ProviderCapabilities {
    return {
      supportsRotation: true,
      supportsVersioning: true,
      supportsLabels: false,
    };
  }
}

export class PostgresKeyStore implements KeyStore {
  private initialized = false;

  constructor() {}

  private async ensureTable(): Promise<void> {
    if (this.initialized) return;
    const db = getDb();
    await db`
      CREATE TABLE IF NOT EXISTS rotation_key_store (
        secret_name TEXT NOT NULL,
        key_id TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (secret_name, key_id)
      )
    `;
    this.initialized = true;
  }

  private serializeKey(key: SecretKey): Record<string, unknown> {
    return {
      keyId: key.keyId,
      secretName: key.secretName,
      encryptedMaterial: key.encryptedMaterial,
      format: key.format,
      validFrom: key.validFrom.toISOString(),
      validUntil: key.validUntil?.toISOString() ?? null,
      status: key.status,
      createdAt: key.createdAt.toISOString(),
      rotatedAt: key.rotatedAt?.toISOString() ?? null,
      revokedAt: key.revokedAt?.toISOString() ?? null,
      metadata: key.metadata ?? null,
    };
  }

  private deserializeRow(row: { data: Record<string, unknown> }): SecretKey {
    const d = row.data;
    return {
      keyId: d.keyId as string,
      secretName: d.secretName as string,
      encryptedMaterial: d.encryptedMaterial as string,
      format: d.format as SecretKey['format'],
      validFrom: new Date(d.validFrom as string),
      validUntil: d.validUntil ? new Date(d.validUntil as string) : undefined,
      status: d.status as SecretKey['status'],
      createdAt: new Date(d.createdAt as string),
      rotatedAt: d.rotatedAt ? new Date(d.rotatedAt as string) : undefined,
      revokedAt: d.revokedAt ? new Date(d.revokedAt as string) : undefined,
      metadata: (d.metadata as Record<string, unknown>) ?? undefined,
    };
  }

  async save(key: SecretKey): Promise<void> {
    await this.ensureTable();
    const db = getDb();
    await db`
      INSERT INTO rotation_key_store (secret_name, key_id, data)
      VALUES (${key.secretName}, ${key.keyId}, ${JSON.stringify(this.serializeKey(key))}::jsonb)
      ON CONFLICT (secret_name, key_id) DO UPDATE SET data = EXCLUDED.data
    `;
  }

  async get(secretName: string, keyId: string): Promise<SecretKey | null> {
    await this.ensureTable();
    const db = getDb();
    const rows = await db<{ data: Record<string, unknown> }[]>`
      SELECT data FROM rotation_key_store
      WHERE secret_name = ${secretName} AND key_id = ${keyId}
      LIMIT 1
    `;
    return rows[0] ? this.deserializeRow(rows[0]) : null;
  }

  async getActive(secretName: string): Promise<SecretKey | null> {
    await this.ensureTable();
    const db = getDb();
    const rows = await db<{ data: Record<string, unknown> }[]>`
      SELECT data FROM rotation_key_store
      WHERE secret_name = ${secretName}
        AND data->>'status' = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return rows[0] ? this.deserializeRow(rows[0]) : null;
  }

  async getValid(secretName: string, at?: Date): Promise<SecretKey[]> {
    await this.ensureTable();
    const db = getDb();
    const ts = (at ?? new Date()).toISOString();
    const rows = await db<{ data: Record<string, unknown> }[]>`
      SELECT data FROM rotation_key_store
      WHERE secret_name = ${secretName}
        AND data->>'validFrom' <= ${ts}
        AND (data->>'validUntil' IS NULL OR data->>'validUntil' >= ${ts})
        AND data->>'status' NOT IN ('revoked', 'failed')
      ORDER BY created_at DESC
    `;
    return rows.map((r) => this.deserializeRow(r));
  }

  async update(key: SecretKey): Promise<void> {
    await this.ensureTable();
    const db = getDb();
    await db`
      UPDATE rotation_key_store
      SET data = ${JSON.stringify(this.serializeKey(key))}::jsonb
      WHERE secret_name = ${key.secretName} AND key_id = ${key.keyId}
    `;
  }

  async delete(secretName: string, keyId: string): Promise<void> {
    await this.ensureTable();
    const db = getDb();
    await db`DELETE FROM rotation_key_store WHERE secret_name = ${secretName} AND key_id = ${keyId}`;
  }

  async list(secretName?: string): Promise<SecretKey[]> {
    await this.ensureTable();
    const db = getDb();
    const rows = secretName
      ? await db<{ data: Record<string, unknown> }[]>`
          SELECT data FROM rotation_key_store WHERE secret_name = ${secretName} ORDER BY created_at DESC
        `
      : await db<{ data: Record<string, unknown> }[]>`
          SELECT data FROM rotation_key_store ORDER BY secret_name, created_at DESC
        `;
    return rows.map((r) => this.deserializeRow(r));
  }
}

/**
 * Record a rotation in `audit_log`. The table requires an `org_id` FK, but
 * secret rotation is platform-internal and not org-scoped. We attribute it to a
 * well-known `platform` organization when one exists; otherwise we log a warning
 * and skip the row rather than fabricate a foreign key.
 */
export async function recordRotationAudit(
  secretName: string,
  newVersionId: string,
): Promise<void> {
  const db = getDb();
  const platformOrg = await db<{ id: string }[]>`
    SELECT id FROM organizations WHERE slug = 'platform' LIMIT 1
  `;
  const orgId = platformOrg[0]?.id;
  if (!orgId) {
    logger.warn(
      { secret: secretName, newVersionId },
      'No platform organization found — skipping secret-rotation audit_log entry',
    );
    return;
  }
  await db`
    INSERT INTO audit_log (org_id, actor, action, target, ip, ts)
    VALUES (${orgId}, 'worker', 'secret:rotate', ${`${secretName}#${newVersionId}`}, '0.0.0.0', now())
  `;
}

export const SecretRotationJobSchema = z.object({
  type: z.enum(['scheduled', 'manual']),
  secrets: z.array(z.string()).optional(),
});

export async function processSecretRotationJob(
  job: Job<SecretRotationJobData>,
): Promise<void> {
  const data = SecretRotationJobSchema.parse(job.data);
  const logCtx = { jobId: job.id, type: data.type };
  logger.info(logCtx, 'Running secret rotation');

  const provider = new PostgresControlledSecretProvider(recordRotationAudit);
  // Seed the durable store from config on first run so each secret has a
  // current version to rotate from.
  await provider.ensureBootstrap();

  // RotationManager wires together the provider, key generator, key store,
  // verifier, rate limiter, rollback manager and event bus. We supply an
  // in-memory key store + polling verifier (the provider is the source of
  // truth for these library-managed secrets) and a 24h rotation interval so
  // the lifecycle's "due for rotation" policy matches the daily schedule.
  const manager = new RotationManager({
    providerInstance: provider,
    keyStore: new PostgresKeyStore(),
    verifier: new PollingPropagationVerifier(provider),
    logger: rotationLogger,
    rotationIntervalMs: 24 * 60 * 60 * 1000,
  });

  // Surface lifecycle events through the worker logger for observability.
  manager.events.on('key_activated', (event) => {
    if (event.type !== 'key_activated') return;
    logger.info(
      { secret: event.secretName, keyId: event.keyId },
      'Secret rotation: key activated',
    );
  });
  manager.events.on('rotation_failed', (event) => {
    if (event.type !== 'rotation_failed') return;
    logger.error(
      { secret: event.secretName, stage: event.stage, error: event.error },
      'Secret rotation: rotation failed',
    );
  });

  const targets = data.secrets ?? [...ROTATABLE_SECRETS];
  const rotationIntervalMs = 24 * 60 * 60 * 1000;

  // Compute nextRotationAt from the durable store so a worker restart does not
  // treat every secret as due. The in-memory keystore loses state on restart;
  // the `current` row's `created_at` in `service_secrets` is the authority.
  for (const secret of targets) {
    try {
      const currentVersion = await provider.getSecret(secret);
      const nextRotationAt = new Date(currentVersion.createdAt.getTime() + rotationIntervalMs);
      if (nextRotationAt > new Date()) {
        logger.info(
          { secret, nextRotationAt, rotatedAt: currentVersion.createdAt },
          'Secret not due for rotation — skipping',
        );
        continue;
      }
    } catch {
      // Secret not yet bootstrapped — proceed to rotate (initial creation).
    }

    try {
      const result: RotationResult = await manager.rotate(secret);
      logger.info(
        {
          secret,
          rotationId: result.rotationId,
          newKeyId: result.newKeyId,
          durationMs: result.duration,
          success: result.success,
        },
        'Secret rotation complete',
      );
    } catch (err) {
      // Rotation is best-effort per secret: one failure must not block the rest.
      logger.error(
        { secret, error: String(err) },
        'Secret rotation failed for secret',
      );
    }
  }

  logger.info(logCtx, 'Secret rotation run complete');
}
