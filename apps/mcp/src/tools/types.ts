import type postgres from "postgres";
import type { EnvConfig } from "@medialocker/config";

/**
 * Context injected into every MediaLocker MCP tool handler.
 *
 * Shape is preserved from the pre-framework implementation so the (recently
 * fixed) tool handlers do not change: `{ sql, auth, config }`. The gateway edge
 * resolves `auth` from the customer API key / Supabase JWT; `sql` and `config`
 * are app-scoped singletons.
 */
export interface ToolHandlerContext {
  sql: ReturnType<typeof postgres>;
  auth: {
    userId?: string;
    orgId: string;
    isMachine: boolean;
    scopes: string[];
    bucketScope?: string | null;
    allowedTools?: string[];
  };
  config: EnvConfig;
}
