import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RotationSession } from '@reaatech/secret-rotation-types';
import { createMockSql } from './helpers/mock-sql';

/**
 * Internal secret rotation persists to the durable, encrypted `service_secrets`
 * table (§5/§17): values are AES-256-GCM ciphertext, versions carry stages, and
 * complete/cancel really mutate the store. These tests assert the SQL + that the
 * plaintext is never written or logged, using a real encrypt/decrypt keyed by a
 * test API_KEY_ENC_KEY supplied through the mocked config.
 */

const infoSpy = vi.fn();
const warnSpy = vi.fn();
const errorSpy = vi.fn();

// 32-byte key, base64 — enables real AES-256-GCM in @medialocker/auth.
const TEST_ENC_KEY = Buffer.alloc(32, 7).toString('base64');

vi.mock('@medialocker/config', () => ({
  getConfig: () => ({
    INTERNAL_API_SECRET: 'internal-secret',
    API_KEY_ENC_KEY: TEST_ENC_KEY,
  }),
}));

vi.mock('../logger', () => ({
  logger: {
    info: (...a: unknown[]) => infoSpy(...a),
    warn: (...a: unknown[]) => warnSpy(...a),
    error: (...a: unknown[]) => errorSpy(...a),
    debug: vi.fn(),
  },
}));

const mock = createMockSql();
vi.mock('../db', () => ({
  getDb: () => mock.sql,
}));

import {
  PostgresControlledSecretProvider,
  recordRotationAudit,
} from '../processors/secret-rotation';
// Real crypto (uses the mocked config's API_KEY_ENC_KEY) to verify round-trips.
import { decrypt, encrypt } from '@medialocker/auth';

beforeEach(() => {
  mock.reset();
  infoSpy.mockClear();
  warnSpy.mockClear();
  errorSpy.mockClear();
});

/** Returns the two stage-mutating UPDATEs that constitute a promote(). */
function promoteQueries() {
  return {
    demote: mock.queries.find(
      (q) =>
        q.text.includes("array_remove(stages, 'current')") &&
        q.text.includes("NOT ('pending' = ANY(stages))"),
    ),
    promote: mock.queries.find((q) =>
      q.text.includes("array_remove(stages, 'pending')"),
    ),
  };
}

describe('internal-api-secret promotion (no external provisioning gate)', () => {
  it('promotes internal-api-secret immediately on completeRotation', async () => {
    const provider = new PostgresControlledSecretProvider(vi.fn());
    await provider.storeSecretValue('internal-api-secret', 'new-internal-secret', {
      stage: 'pending',
    });
    await provider.completeRotation(await provider.beginRotation('internal-api-secret'));

    const { promote, demote } = promoteQueries();
    expect(promote).toBeDefined(); // pending → current
    expect(demote).toBeDefined(); // prior current → previous
  });
});

describe('PostgresControlledSecretProvider', () => {
  it('stores an ENCRYPTED new version and audits it', async () => {
    const audit = vi.fn().mockResolvedValue(undefined);
    const provider = new PostgresControlledSecretProvider(audit);

    const stored = await provider.storeSecretValue('internal-api-secret', 'new-key');

    const insert = mock.queries.find((q) =>
      q.text.includes('INSERT INTO service_secrets'),
    );
    expect(insert).toBeDefined();
    // params: [name, versionId, valueEnc, [stage]]
    const valueEnc = insert?.params[2] as string;
    expect(valueEnc).not.toBe('new-key'); // ciphertext, not plaintext
    expect(decrypt(valueEnc)).toBe('new-key'); // round-trips
    expect(insert?.params[0]).toBe('internal-api-secret');

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith('internal-api-secret', stored.versionId);
  });

  it('demotes the prior current version when storing a new current', async () => {
    const provider = new PostgresControlledSecretProvider(vi.fn());
    await provider.storeSecretValue('internal-api-secret', 'rotated');

    const demote = mock.queries.find(
      (q) =>
        q.text.includes('UPDATE') &&
        q.text.includes("array_remove(stages, 'current')"),
    );
    expect(demote).toBeDefined();
    expect(demote?.params).toContain('internal-api-secret');
  });

  it('never writes or logs the secret VALUE in plaintext', async () => {
    const provider = new PostgresControlledSecretProvider(vi.fn());
    await provider.storeSecretValue('internal-api-secret', 'super-sensitive-value');

    const loggedAll = JSON.stringify([
      ...infoSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
    ]);
    expect(loggedAll).not.toContain('super-sensitive-value');

    // The only param carrying the value is encrypted.
    const allParams = JSON.stringify(mock.queries.map((q) => q.params));
    expect(allParams).not.toContain('super-sensitive-value');
  });

  it('reads and DECRYPTS the current version via getSecret', async () => {
    const provider = new PostgresControlledSecretProvider(vi.fn());
    // Simulate the stored row: value encrypted with the same test key.
    mock.onQuery('FROM service_secrets', [
      {
        version_id: 'v-1',
        value_enc: encrypt('the-live-value'),
        stages: ['current'],
        created_at: new Date(),
      },
    ]);

    const got = await provider.getSecret('internal-api-secret');
    expect(got.value).toBe('the-live-value');
    expect(got.versionId).toBe('v-1');
    expect(got.versionStages).toEqual(['current']);
  });

  it('completeRotation promotes pending→current and demotes the old current', async () => {
    const provider = new PostgresControlledSecretProvider(vi.fn());
    const session = await provider.beginRotation('internal-api-secret');
    await provider.completeRotation(session);

    const promote = mock.queries.find((q) =>
      q.text.includes("array_remove(stages, 'pending')"),
    );
    const demote = mock.queries.find(
      (q) =>
        q.text.includes("array_remove(stages, 'current')") &&
        q.text.includes("NOT ('pending' = ANY(stages))"),
    );
    expect(promote).toBeDefined();
    expect(demote).toBeDefined();
  });

  it('cancelRotation deletes the un-activated pending version (real rollback)', async () => {
    const provider = new PostgresControlledSecretProvider(vi.fn());
    const session: RotationSession = await provider.beginRotation('internal-api-secret');
    await provider.cancelRotation(session);

    const del = mock.queries.find(
      (q) =>
        q.text.includes('DELETE FROM service_secrets') &&
        q.text.includes("'pending' = ANY(stages)"),
    );
    expect(del).toBeDefined();
    expect(del?.params).toContain('internal-api-secret');
  });

  it('ensureBootstrap seeds a current version only when none exists', async () => {
    const provider = new PostgresControlledSecretProvider(vi.fn());
    // No existing rows → SELECT 1 returns [] (default), so each secret is seeded.
    await provider.ensureBootstrap();

    const inserts = mock.queries.filter((q) =>
      q.text.includes('INSERT INTO service_secrets'),
    );
    // One per ROTATABLE_SECRETS entry (internal-api-secret only).
    expect(inserts.length).toBe(1);
    // Seeded with the literal 'bootstrap' version id.
    expect(inserts.every((q) => q.params[1] === 'bootstrap')).toBe(true);
  });

  it('reports rotation capability and healthy status', async () => {
    const provider = new PostgresControlledSecretProvider(vi.fn());
    expect(provider.supportsRotation()).toBe(true);
    expect((await provider.health()).status).toBe('healthy');
  });
});

describe('recordRotationAudit', () => {
  it('inserts an audit_log row attributed to the platform org', async () => {
    mock.onQuery('FROM organizations', [{ id: 'platform-org' }]);

    await recordRotationAudit('internal-api-secret', 'v-42');

    const insert = mock.queries.find((q) => q.text.includes('INSERT INTO audit_log'));
    expect(insert).toBeDefined();
    expect(insert?.params).toContain('platform-org');
    expect(insert?.params).toContain('internal-api-secret#v-42');
    expect(insert?.text).toContain("'secret:rotate'");
  });

  it('skips the audit row (and warns) when no platform org exists', async () => {
    mock.onQuery('FROM organizations', []);

    await recordRotationAudit('internal-api-secret', 'v-1');

    expect(mock.queries.some((q) => q.text.includes('INSERT INTO audit_log'))).toBe(
      false,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
