import { readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Turn a human description into a filename-safe slug: lowercase, non-alphanumeric
 * runs collapsed to a single underscore, leading/trailing underscores trimmed.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Compute the next zero-padded sequence prefix from the existing migrations.
 * Migrations are applied in filename order (see `runMigrations`), so the prefix
 * must sort lexicographically — we pad to at least 3 digits to match
 * `001_…`, `010_…`, and widen automatically once the count passes 999.
 */
function nextPrefix(files: string[]): string {
  const max = files
    .map((f) => /^(\d+)_/.exec(f)?.[1])
    .filter((n): n is string => n != null)
    .reduce((acc, n) => Math.max(acc, Number(n)), 0);
  const next = max + 1;
  return String(next).padStart(Math.max(3, String(max).length), "0");
}

/**
 * Scaffold the next migration file in `migrationsDir` for `name` and return its
 * absolute path. Pure of any global state (directory injected) so it is
 * unit-testable without touching the real migrations folder.
 *
 * Applied migrations are immutable (the runner checksums them), so the workflow
 * is always "add a new file" — this just removes the manual bookkeeping of
 * picking the next number and the header boilerplate.
 */
export function createMigration(migrationsDir: string, name: string): string {
  const slug = slugify(name);
  if (!slug) {
    throw new Error(
      "Migration name must contain at least one alphanumeric character.",
    );
  }

  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  const prefix = nextPrefix(files);
  const filename = `${prefix}_${slug}.sql`;
  const path = join(migrationsDir, filename);

  const title = name.trim();
  const content = `-- ============================================================================
-- ${prefix}: ${title}
-- ============================================================================
-- Describe what this migration does and why. Prefer additive, backward-
-- compatible changes (nullable/defaulted columns) so existing deployments
-- migrate cleanly. Each file runs once, inside its own transaction.

`;

  // Fail rather than clobber if the computed name somehow already exists.
  writeFileSync(path, content, { encoding: "utf-8", flag: "wx" });
  return path;
}

/** CLI wrapper: read the migration name from argv and scaffold the file. */
function generateCli(): void {
  const name = process.argv.slice(2).join(" ").trim();
  if (!name) {
    console.error(
      "Usage: pnpm --filter @medialocker/db generate <migration name>\n" +
        '       e.g. pnpm --filter @medialocker/db generate "add object archive flag"',
    );
    process.exit(1);
  }

  const migrationsDir = join(import.meta.dirname, "..", "migrations");
  const path = createMigration(migrationsDir, name);
  console.log(`Created ${path}`);
}

// Only run the CLI when this file is the process entrypoint (i.e. `tsx
// scripts/generate.ts`), so importing `createMigration` in tests does not write.
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  generateCli();
}
