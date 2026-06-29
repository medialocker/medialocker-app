import { z } from "zod";
import { createApiKey } from "@medialocker/auth";
import { ToolHandlerContext } from "./types.js";
import { registerSearchTools } from "./search.js";
import { registerBucketTools } from "./buckets.js";
import { registerObjectTools } from "./objects.js";
import { registerTagTools } from "./tags.js";
import { registerSetTools } from "./sets.js";
import { registerUsageTools } from "./usage.js";

/**
 * A MediaLocker MCP tool: name + JSON-Schema input + handler over
 * `ToolHandlerContext`. This is the registration shape the server bridge
 * (`src/server.ts`) consumes before adapting it onto `@reaatech/mcp-server-tools`
 * and the MCP SDK.
 */
export interface MediaLockerTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (
    params: Record<string, unknown>,
    context: ToolHandlerContext,
  ) => Promise<unknown>;
}

export type RegisterTool = (tool: MediaLockerTool) => void;

export function registerAllTools(registerTool: RegisterTool): void {
  registerTool({
    name: "create_api_key",
    description: "Create a new API key for the organization. Requires admin scope. The secret is returned once.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Key name (label)" },
        scopes: { type: "array", items: { type: "string", enum: ["read", "write", "delete", "admin"] }, description: "Permission scopes" },
        bucketId: { type: "string", description: "Restrict to bucket (UUID, optional)" },
        expiresInDays: { type: "number", description: "Days until expiry (default 90, max 365)" },
      },
      required: ["name"],
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth }: ToolHandlerContext) => {
      const schema = z.object({
        name: z.string().min(1),
        scopes: z.array(z.enum(["read", "write", "delete", "admin"])).optional(),
        bucketId: z.string().uuid().optional(),
        expiresInDays: z.number().min(1).max(365).optional(),
      });
      const { name, scopes, bucketId, expiresInDays } = schema.parse(rawParams);

      if (!auth.scopes.includes("admin")) {
        throw new Error("Missing required scope: admin");
      }

      const keyScopes: string[] = scopes ?? ["read"];

      let bucketScope: string | undefined;
      if (bucketId) {
        const b = await sql<{ name: string }[]>`
          SELECT name FROM buckets
          WHERE id = ${bucketId} AND org_id = ${auth.orgId} AND deleted_at IS NULL
          LIMIT 1
        `;
        if (b.length === 0) throw new Error(`Bucket not found: ${bucketId}`);
        bucketScope = b[0]!.name;
      }

      const days = Math.min(expiresInDays ?? 90, 365);
      const result = await createApiKey(auth.orgId, keyScopes, bucketScope, days, name);
      const expiresAt = new Date(Date.now() + days * 86400000).toISOString();

      void sql`INSERT INTO audit_log (org_id, actor, action, target, ip, ts) VALUES (${auth.orgId}, ${auth.userId ?? "mcp"}, 'create_api_key', ${result.accessKeyId}, null, now())`.catch(() => {});

      return {
        id: result.keyId,
        name,
        accessKeyId: result.accessKeyId,
        secret: result.secret,
        scopes: keyScopes,
        expiresAt,
        note: "Store this secret securely — it will not be shown again.",
      };
    },
  });

  registerSearchTools(registerTool);
  registerBucketTools(registerTool);
  registerObjectTools(registerTool);
  registerTagTools(registerTool);
  registerSetTools(registerTool);
  registerUsageTools(registerTool);
}

export type { ToolHandlerContext };
