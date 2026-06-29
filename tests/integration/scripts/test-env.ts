/**
 * Single source of truth for how the harness reaches the throwaway stack
 * defined in docker-compose.test.yml. The host ports here MUST mirror the
 * compose file. Each value is overridable via a TEST_* env var so CI (or a
 * developer running the stack on different ports) can point the suite elsewhere
 * without editing code.
 *
 * `applyTestEnv()` also writes the corresponding @medialocker/config env vars
 * (DATABASE_URL, REDIS_URL, HETZNER_S3_*) into process.env BEFORE
 * `@medialocker/config` is first loaded, so the core/billing code under test
 * constructs its real clients against the test stack — exactly the production
 * wiring path, just pointed at disposable infra.
 *
 * Note: there is no object-storage container in the test stack — tenant uploads
 * go browser→Hetzner via presigned URLs (no in-process data plane), and the
 * remaining suites only touch the capacity/billing SQL paths. The HETZNER_S3_*
 * values below are dummy placeholders that satisfy @medialocker/config's schema
 * (it has defaults for them); nothing in the harness connects to them.
 */

export interface TestEnv {
  pgHost: string;
  pgPort: number;
  pgUser: string;
  pgPassword: string;
  pgDatabase: string;
  databaseUrl: string;

  hetznerEndpoint: string; // placeholder; nothing connects to it
  hetznerRegion: string;
  hetznerAccessKey: string;
  hetznerSecretKey: string;

  redisUrl: string;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}

function str(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export function getTestEnv(): TestEnv {
  const pgHost = str("TEST_PG_HOST", "127.0.0.1");
  const pgPort = num("TEST_PG_PORT", 55432);
  const pgUser = str("TEST_PG_USER", "postgres");
  const pgPassword = str("TEST_PG_PASSWORD", "postgres");
  const pgDatabase = str("TEST_PG_DATABASE", "medialocker_test");
  const databaseUrl =
    process.env.TEST_DATABASE_URL ??
    `postgresql://${pgUser}:${pgPassword}@${pgHost}:${pgPort}/${pgDatabase}`;

  const redisHost = str("TEST_REDIS_HOST", "127.0.0.1");
  const redisPort = num("TEST_REDIS_PORT", 56379);
  const redisUrl =
    process.env.TEST_REDIS_URL ?? `redis://${redisHost}:${redisPort}`;

  return {
    pgHost,
    pgPort,
    pgUser,
    pgPassword,
    pgDatabase,
    databaseUrl,
    hetznerEndpoint: str(
      "TEST_HETZNER_S3_ENDPOINT",
      "https://test.your-objectstorage.com",
    ),
    hetznerRegion: str("TEST_HETZNER_S3_REGION", "us-east-1"),
    hetznerAccessKey: str("TEST_HETZNER_S3_ACCESS_KEY", "test-access-key"),
    hetznerSecretKey: str("TEST_HETZNER_S3_SECRET_KEY", "test-secret-key"),
    redisUrl,
  };
}

/**
 * Mirror the test stack into the env vars that @medialocker/config reads, so
 * `getConfig()` (and therefore the core/billing client constructors) targets the
 * throwaway stack. Call this BEFORE anything imports @medialocker/config; the
 * global setup does so up front.
 */
export function applyTestEnv(env: TestEnv = getTestEnv()): void {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = env.databaseUrl;
  process.env.REDIS_URL = env.redisUrl;
  // Dummy Hetzner Object Storage creds — config validates/defaults these, but
  // the harness never opens an S3 connection (no data plane under test).
  process.env.HETZNER_S3_ENDPOINT = env.hetznerEndpoint;
  process.env.HETZNER_S3_REGION = env.hetznerRegion;
  process.env.HETZNER_S3_ACCESS_KEY = env.hetznerAccessKey;
  process.env.HETZNER_S3_SECRET_KEY = env.hetznerSecretKey;
}
