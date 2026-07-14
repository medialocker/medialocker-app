import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { getConfig } from "@medialocker/config";

/** sha256 hex digest of a migration file's bytes, used as its checksum. */
function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Minimal logger surface the runner needs — defaults to `console` but is
 * injectable so tests can assert on emitted lines without noisy output.
 */
type MigrationLogger = Pick<Console, "log">;

/**
 * Apply every pending `.sql` migration in `migrationsDir` exactly once, in
 * filename order, each inside its own transaction, tracking applied names in a
 * `migrations` table. Pure of any global state: the postgres client and the
 * directory are injected so this is unit-testable without a live database.
 *
 * @returns the list of migration filenames that were actually executed this run
 *   (already-applied files are skipped and excluded).
 */
export async function runMigrations(
  sql: Sql,
  migrationsDir: string,
  logger: MigrationLogger = console,
): Promise<string[]> {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    logger.log("No migration files found.");
    return [];
  }

  await sql`CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

  // P2.48: track a sha256 checksum of each migration's contents so a silently
  // edited (already-applied) migration is detected. Added separately so existing
  // installs whose `migrations` table predates this column are upgraded in place.
  await sql`ALTER TABLE migrations ADD COLUMN IF NOT EXISTS checksum TEXT`;

  // Enable RLS on this internal tracker. Supabase exposes every `public` table
  // via PostgREST on the anon key, so a table without RLS is world-readable/
  // writable (the `rls_disabled_in_public` advisory). With no policies, RLS
  // denies anon/authenticated while the owner (this migration runner) is
  // unaffected. Idempotent — a no-op once enabled.
  await sql`ALTER TABLE migrations ENABLE ROW LEVEL SECURITY`;

  const lockId = 0x3a99_7b1d;

  const lockResult = await sql<
    { locked: boolean }[]
  >`SELECT pg_try_advisory_lock(${lockId}) AS locked`;
  if (!lockResult[0]?.locked) {
    throw new Error(
      "Migration lock is held by another process. Is another migration running?",
    );
  }
  logger.log("Acquired migration advisory lock.");

  const applied: string[] = [];

  try {
    for (const file of files) {
      const content = readFileSync(join(migrationsDir, file), "utf-8");
      const checksum = sha256Hex(content);

      const alreadyRun = await sql<
        { name: string; checksum: string | null }[]
      >`SELECT name, checksum FROM migrations WHERE name = ${file} LIMIT 1`;

      if (alreadyRun.length > 0) {
        const prior = alreadyRun[0]!.checksum;
        // A NULL prior checksum means the row predates the checksum column; we
        // can't verify it, so backfill it from the current file rather than
        // false-alarm. A non-NULL mismatch means an applied migration was edited
        // after the fact — that is a correctness hazard, so fail loudly.
        if (prior == null) {
          await sql`UPDATE migrations SET checksum = ${checksum} WHERE name = ${file}`;
          logger.log(`Backfilled checksum for ${file}`);
        } else if (prior !== checksum) {
          throw new Error(
            `Checksum mismatch for already-applied migration ${file}: ` +
              `recorded ${prior} but file now hashes to ${checksum}. ` +
              `Applied migrations are immutable — create a new migration instead.`,
          );
        }
        logger.log(`Skipping ${file} (already executed)`);
        continue;
      }

      logger.log(`Running migration: ${file}`);

      await sql.begin(async (tx) => {
        await tx.unsafe(content);
        await tx`INSERT INTO migrations (name, checksum) VALUES (${file}, ${checksum})`;
      });

      applied.push(file);
      logger.log(`  ✓ ${file} complete`);
    }

    logger.log("All migrations complete.");
    return applied;
  } finally {
    await sql`SELECT pg_advisory_unlock(${lockId})`;
    logger.log("Released migration advisory lock.");
  }
}

/** CLI wrapper: open a connection from config, run, and always close it. */
async function migrateCli(): Promise<void> {
  const migrationsDir = join(import.meta.dirname, "..", "migrations");

  // IMPORTANT: the migration runner holds a SESSION-level advisory lock
  // (pg_try_advisory_lock) across all migrations, so it must run on a
  // session-persistent connection — the Supabase Cloud SESSION pooler (port 5432)
  // or a direct connection, NOT the transaction pooler (6543), which would drop
  // the lock between transactions. `prepare: false` is harmless and keeps the URL
  // interchangeable. TLS via the connection string (`?sslmode=require`).
  const sql = postgres(getConfig().DATABASE_URL, {
    max: 1,
    idle_timeout: 5_000,
    connect_timeout: 10_000,
    prepare: false,
  });

  try {
    await runMigrations(sql, migrationsDir);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only run the CLI when this file is the process entrypoint (i.e. `tsx
// scripts/migrate.ts`), so importing `runMigrations` in tests does not connect.
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  migrateCli().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
