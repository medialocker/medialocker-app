/**
 * Bring the throwaway stack to a ready, migrated state.
 *
 * Steps:
 *   1. Wait for Postgres and Redis to accept connections (the compose
 *      healthchecks cover the containers, but the host may reach them slightly
 *      later, and CI may invoke this before `up` settles — so we poll). There is
 *      no object-storage container: the remaining suites only exercise the
 *      capacity/billing SQL paths against Postgres.
 *   2. Ensure the `medialocker_service` role exists with a password and create
 *      a clean `medialocker_test` schema state, then apply
 *      packages/db/migrations/*.sql in filename order via the REAL migration
 *      runner (packages/db/scripts/migrate.ts `runMigrations`) — the same code
 *      production uses, so the harness exercises the exact migration path.
 *   3. Seed the global `plans` rows are NOT seeded here (tests seed their own
 *      isolated plan/org fixtures); we only verify the schema is live.
 *
 * Usable two ways:
 *   - As the vitest globalSetup (default export) — see vitest.config.ts.
 *   - Standalone:  pnpm --dir tests/integration exec tsx scripts/setup.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import Redis from "ioredis";
import { getTestEnv, applyTestEnv } from "./test-env.js";

const MIGRATIONS_DIR = join(
  fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url)),
);

async function waitFor(
  label: string,
  attempt: () => Promise<void>,
  { retries = 60, delayMs = 1000 } = {},
): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      await attempt();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(
    `Timed out waiting for ${label}: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

async function waitForPostgres(databaseUrl: string): Promise<void> {
  await waitFor("postgres", async () => {
    const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
    try {
      await sql`SELECT 1`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
}

async function waitForRedis(redisUrl: string): Promise<void> {
  await waitFor("redis", async () => {
    const redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      connectTimeout: 3000,
    });
    try {
      await redis.connect();
      await redis.ping();
    } finally {
      redis.disconnect();
    }
  });
}

/**
 * Provision the roles the migrations GRANT to.
 *
 * Migration 001 self-creates `medialocker_service` (guarded), but it also does
 * `GRANT USAGE ON SCHEMA public TO authenticated` and `... TO anon`. Those two
 * roles exist on Supabase but NOT on a vanilla postgres:16-alpine, so the GRANTs
 * would fail. We create all three roles up front (idempotently) so the real,
 * unmodified production migrations apply cleanly against the throwaway DB.
 */
async function ensureRoles(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await sql.unsafe(`
      DO $$ BEGIN
        CREATE ROLE medialocker_service WITH LOGIN BYPASSRLS PASSWORD 'password';
      EXCEPTION WHEN duplicate_object THEN
        ALTER ROLE medialocker_service WITH LOGIN BYPASSRLS PASSWORD 'password';
      END $$;
      DO $$ BEGIN
        CREATE ROLE authenticated NOLOGIN;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
      DO $$ BEGIN
        CREATE ROLE anon NOLOGIN;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Apply every pending .sql migration in `migrationsDir` in filename order, each
 * in its own transaction, tracked in a `migrations` table.
 *
 * This is a faithful copy of packages/db/scripts/migrate.ts `runMigrations`
 * (same algorithm, same per-file transaction, same dedup table). We copy rather
 * than import it because that module eagerly does `import { config } from
 * "@medialocker/config"` and the config package exports no `config` binding —
 * importing it would fail to resolve. The harness must not depend on that drift,
 * so the runner is inlined here, parameterized purely by `sql` + dir.
 */
async function runMigrations(sql: Sql, migrationsDir: string): Promise<string[]> {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) return [];

  await sql`CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

  const applied: string[] = [];
  for (const file of files) {
    const alreadyRun = await sql<{ name: string }[]>`
      SELECT name FROM migrations WHERE name = ${file} LIMIT 1
    `;
    if (alreadyRun.length > 0) continue;

    const content = readFileSync(join(migrationsDir, file), "utf-8");
    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`INSERT INTO migrations (name) VALUES (${file})`;
    });
    applied.push(file);
  }
  return applied;
}

export async function applyMigrations(databaseUrl: string): Promise<string[]> {
  const sql = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
  });
  try {
    return await runMigrations(sql, MIGRATIONS_DIR);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Full bring-up: wait for health, ensure role, run migrations. */
export async function setupStack(): Promise<void> {
  const env = getTestEnv();
  applyTestEnv(env);

  await Promise.all([
    waitForPostgres(env.databaseUrl),
    waitForRedis(env.redisUrl),
  ]);

  await ensureRoles(env.databaseUrl);
  const applied = await applyMigrations(env.databaseUrl);
  // eslint-disable-next-line no-console
  console.log(
    `[itest] stack ready — ${applied.length} migration(s) applied this run`,
  );
}

// vitest globalSetup default export.
export default async function globalSetup(): Promise<void> {
  await setupStack();
}

// Standalone CLI: `tsx scripts/setup.ts`.
const invokedPath = process.argv[1] ? process.argv[1] : "";
if (invokedPath && invokedPath.endsWith("setup.ts")) {
  setupStack().catch((err) => {
    console.error("[itest] setup failed:", err);
    process.exit(1);
  });
}
