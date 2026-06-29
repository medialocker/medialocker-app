/**
 * Resolve the MCP server version from its own package.json at runtime, so the
 * version is never hardcoded in the health endpoint or the llms.txt discovery
 * document. The lookup walks up from this module's directory until it finds a
 * package.json whose `name` is `@medialocker/mcp` (works whether we run from
 * `src/` via tsx or from the compiled `dist/`).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@medialocker/mcp";
const FALLBACK_VERSION = "0.0.0";

function resolveVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  // Walk up a bounded number of levels looking for our package.json.
  for (let i = 0; i < 8; i += 1) {
    try {
      const pkgPath = join(dir, "package.json");
      const raw = readFileSync(pkgPath, "utf8");
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // Not here (or unreadable) — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return FALLBACK_VERSION;
}

/** The MCP server version, read once from package.json at module load. */
export const MCP_VERSION: string = resolveVersion();
