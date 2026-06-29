import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMigration } from "../scripts/generate";

describe("createMigration", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ml-generate-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("scaffolds 001 in an empty migrations dir", () => {
    const path = createMigration(dir, "initial schema");
    expect(basename(path)).toBe("001_initial_schema.sql");
  });

  it("uses the next sequence after the highest existing prefix", () => {
    writeFileSync(join(dir, "001_a.sql"), "");
    writeFileSync(join(dir, "002_b.sql"), "");
    // Non-sql files and gaps are ignored; numbering follows the max prefix.
    writeFileSync(join(dir, "notes.txt"), "ignore");

    const path = createMigration(dir, "Add Object Archive Flag");
    expect(basename(path)).toBe("003_add_object_archive_flag.sql");
  });

  it("slugifies the name (lowercase, non-alphanumeric collapsed, trimmed)", () => {
    const path = createMigration(dir, "  Add  pg_trgm: fuzzy!! index  ");
    expect(basename(path)).toBe("001_add_pg_trgm_fuzzy_index.sql");
  });

  it("keeps prefixes lexicographically sortable, widening past 999", () => {
    writeFileSync(join(dir, "999_z.sql"), "");
    const path = createMigration(dir, "next");
    expect(basename(path)).toBe("1000_next.sql");
  });

  it("writes a header carrying the prefix and the original title", () => {
    const path = createMigration(dir, "add archive flag");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("-- 001: add archive flag");
  });

  it("throws when the name has no alphanumeric characters", () => {
    expect(() => createMigration(dir, "  ---  ")).toThrow(
      /at least one alphanumeric/,
    );
  });
});
