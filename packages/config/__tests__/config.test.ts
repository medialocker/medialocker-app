import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, getConfig, resetConfig } from '../src/index.js';

describe('loadConfig', () => {
  beforeEach(() => {
    resetConfig();
  });

  afterEach(() => {
    resetConfig();
  });

  it('loads config with defaults', () => {
    const config = loadConfig();
    expect(config.NODE_ENV).toBe('test');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.PUBLIC_BASE_DOMAIN).toBe('medialocker.io');
    expect(config.DATABASE_URL).toContain('postgresql');
    expect(config.REDIS_URL).toContain('redis');
  });

  it('accepts overrides', () => {
    const config = loadConfig({ NODE_ENV: 'test' as const, LOG_LEVEL: 'debug' });
    expect(config.NODE_ENV).toBe('test');
    expect(config.LOG_LEVEL).toBe('debug');
  });

  it('accepts a production config when real secrets are supplied', () => {
    const config = loadConfig({
      NODE_ENV: 'production' as const,
      INTERNAL_API_SECRET: 'a-real-internal-secret-value',
      API_KEY_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
      HETZNER_S3_ACCESS_KEY: 'real-hetzner-access',
      HETZNER_S3_SECRET_KEY: 'real-hetzner-secret',
      DATABASE_URL: 'postgresql://postgres.ref:realpw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require',
      // Dashboard JWTs are verified via the project JWKS — only SUPABASE_URL is
      // needed in production; there is no shared JWT secret.
      SUPABASE_URL: 'https://abcdefgh.supabase.co',
    });
    expect(config.NODE_ENV).toBe('production');
  });

  it('refuses to boot in production with placeholder secrets', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' as const })).toThrow(
      /must be set to a real secret in production/,
    );
  });

  it('rejects an API_KEY_ENC_KEY that is not 32 bytes', () => {
    expect(() => loadConfig({ API_KEY_ENC_KEY: 'dG9vLXNob3J0' })).toThrow(
      /exactly 32 bytes/,
    );
  });

  it('caches config after first load', () => {
    const config1 = loadConfig();
    const config2 = getConfig();
    expect(config1).toBe(config2);
  });
});

describe('resetConfig', () => {
  it('clears cached config', () => {
    loadConfig();
    resetConfig();
    const config = getConfig();
    expect(config).toBeDefined();
  });
});
