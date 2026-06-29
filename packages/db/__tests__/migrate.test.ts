import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sql } from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

/**
 * Records the runner's interaction with the postgres client in call order so we
 * can assert ordering + transaction wrapping without a live database. The mock
 * is callable as a tagged template (like the real `postgres` client), exposes
 * `.begin`, and yields a `tx` that is itself a tagged template with `.unsafe`.
 */
function createMockSql(
  appliedAlready: Set<string> = new Set(),
  appliedChecksums: Map<string, string | null> = new Map(),
) {
  const events: string[] = [];
  const render = (strings: TemplateStringsArray) => strings.join("?").trim();

  // Transaction handle passed into sql.begin(fn).
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = render(strings);
    if (text.startsWith("INSERT INTO migrations")) {
      events.push(`insert:${String(values[0])}`);
    } else {
      events.push(`tx-query:${text.slice(0, 24)}`);
    }
    return Promise.resolve([]);
  }) as unknown as Sql & {
    unsafe: (content: string) => Promise<unknown[]>;
  };
  (tx as unknown as { unsafe: (c: string) => Promise<unknown[]> }).unsafe = (
    content: string,
  ) => {
    events.push(`unsafe:${content}`);
    return Promise.resolve([]);
  };

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = render(strings);
    if (text.startsWith("CREATE TABLE IF NOT EXISTS migrations")) {
      events.push("create-table");
      return Promise.resolve([]);
    }
    if (text.startsWith("ALTER TABLE migrations ADD COLUMN IF NOT EXISTS checksum")) {
      events.push("add-checksum-col");
      return Promise.resolve([]);
    }
    if (text.startsWith("SELECT pg_try_advisory_lock")) {
      events.push("lock");
      return Promise.resolve([{ locked: true }]);
    }
    if (text.startsWith("SELECT pg_advisory_unlock")) {
      events.push("unlock");
      return Promise.resolve([]);
    }
    if (text.startsWith("SELECT name, checksum FROM migrations")) {
      const file = String(values[0]);
      events.push(`check:${file}`);
      return Promise.resolve(
        appliedAlready.has(file)
          ? [{ name: file, checksum: appliedChecksums.get(file) ?? null }]
          : [],
      );
    }
    if (text.startsWith("UPDATE migrations SET checksum")) {
      events.push("backfill-checksum");
      return Promise.resolve([]);
    }
    events.push(`query:${text.slice(0, 24)}`);
    return Promise.resolve([]);
  }) as unknown as Sql & { begin: (fn: (t: Sql) => Promise<void>) => Promise<void> };

  (sql as unknown as { begin: (fn: (t: unknown) => Promise<void>) => Promise<void> }).begin =
    async (fn: (t: unknown) => Promise<void>) => {
      events.push("begin-start");
      await fn(tx);
      events.push("begin-end");
    };

  return { sql: sql as Sql, events };
}

describe("runMigrations", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ml-migrate-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op when the directory has no .sql files", async () => {
    writeFileSync(join(dir, "README.md"), "# not a migration");
    const { sql, events } = createMockSql();
    const logger = { log: vi.fn() };

    const applied = await runMigrations(sql, dir, logger);

    expect(applied).toEqual([]);
    // No table is created and no queries run when there is nothing to do.
    expect(events).toEqual([]);
    expect(logger.log).toHaveBeenCalledWith("No migration files found.");
  });

  it("filters to .sql files and runs them in sorted filename order", async () => {
    // Written out of order, with a non-sql file mixed in.
    writeFileSync(join(dir, "003_c.sql"), "SELECT 3;");
    writeFileSync(join(dir, "001_a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "notes.txt"), "ignore me");
    writeFileSync(join(dir, "002_b.sql"), "SELECT 2;");

    const { sql, events } = createMockSql();

    const applied = await runMigrations(sql, dir, { log: vi.fn() });

    expect(applied).toEqual(["001_a.sql", "002_b.sql", "003_c.sql"]);
    // The migrations table is created exactly once, before any migration runs.
    expect(events[0]).toBe("create-table");
    expect(events.filter((e) => e === "create-table")).toHaveLength(1);
    // notes.txt never appears.
    expect(events.some((e) => e.includes("notes.txt"))).toBe(false);
  });

  it("wraps each migration in a transaction: unsafe(content) then insert(name)", async () => {
    writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE foo (id int);");
    const { sql, events } = createMockSql();

    await runMigrations(sql, dir, { log: vi.fn() });

    expect(events).toEqual([
      "create-table",
      "add-checksum-col",
      "lock",
      "check:001_a.sql",
      "begin-start",
      "unsafe:CREATE TABLE foo (id int);",
      "insert:001_a.sql",
      "begin-end",
      "unlock",
      // (the runner returns after this; "All migrations complete." is a log)
    ]);
  });

  it("acquires the advisory lock before running and releases it after", async () => {
    writeFileSync(join(dir, "001_a.sql"), "SELECT 1;");
    const { sql, events } = createMockSql();

    await runMigrations(sql, dir, { log: vi.fn() });

    expect(events.indexOf("lock")).toBeLessThan(events.indexOf("begin-start"));
    expect(events.indexOf("unlock")).toBeGreaterThan(events.indexOf("begin-end"));
  });

  it("throws when an applied migration's checksum no longer matches the file", async () => {
    writeFileSync(join(dir, "001_a.sql"), "SELECT 1;");
    const { sql } = createMockSql(
      new Set(["001_a.sql"]),
      new Map([["001_a.sql", "deadbeef-stale-checksum"]]),
    );

    await expect(runMigrations(sql, dir, { log: vi.fn() })).rejects.toThrow(
      /Checksum mismatch/,
    );
  });

  it("backfills a missing checksum for a pre-existing applied migration", async () => {
    writeFileSync(join(dir, "001_a.sql"), "SELECT 1;");
    const { sql, events } = createMockSql(
      new Set(["001_a.sql"]),
      new Map([["001_a.sql", null]]),
    );

    const applied = await runMigrations(sql, dir, { log: vi.fn() });

    expect(applied).toEqual([]); // already applied → not re-run
    expect(events).toContain("backfill-checksum");
  });

  it("skips migrations already recorded in the migrations table", async () => {
    writeFileSync(join(dir, "001_a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "002_b.sql"), "SELECT 2;");
    const { sql, events } = createMockSql(new Set(["001_a.sql"]));
    const logger = { log: vi.fn() };

    const applied = await runMigrations(sql, dir, logger);

    // Only the un-applied file runs.
    expect(applied).toEqual(["002_b.sql"]);
    // 001 is checked but never executed (no begin/unsafe for its content).
    expect(events).toContain("check:001_a.sql");
    expect(events).not.toContain("unsafe:SELECT 1;");
    expect(events).toContain("unsafe:SELECT 2;");
    expect(logger.log).toHaveBeenCalledWith(
      "Skipping 001_a.sql (already executed)",
    );
  });

  it("reads each migration's actual file content for execution", async () => {
    const content = "CREATE INDEX idx_unique_marker ON objects (key);";
    writeFileSync(join(dir, "001_only.sql"), content);
    const { sql, events } = createMockSql();

    await runMigrations(sql, dir, { log: vi.fn() });

    expect(events).toContain(`unsafe:${content}`);
  });
});
