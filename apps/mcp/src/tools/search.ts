import { z } from "zod";
import { buildSearchQuery, sanitizeSearchQuery, type SearchFilters } from "@medialocker/media";
import { ToolHandlerContext } from "./types.js";

export function registerSearchTools(registerTool: (tool: any) => void): void {
  registerTool({
    name: "search_media",
    description: "Full-text search across media assets with filters for kind, tags, size, date range, and bucket.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search query (full-text search)" },
        kind: { type: "string", enum: ["image", "video", "audio", "pdf", "3d", "other"], description: "Media kind filter" },
        tags: { type: "string", description: "Comma-separated tag slugs to filter by" },
        categories: { type: "string", description: "Comma-separated category slugs to filter by" },
        bucketId: { type: "string", description: "Bucket ID to search within" },
        sizeMin: { type: "number", description: "Minimum file size in bytes" },
        sizeMax: { type: "number", description: "Maximum file size in bytes" },
        limit: { type: "number", description: "Max results (default 50, max 100)" },
        offset: { type: "number", description: "Pagination offset (default 0)" },
      },
      required: ["q"],
    },
    handler: async (rawParams: Record<string, unknown>, { sql, auth }: ToolHandlerContext) => {
      const schema = z.object({
        q: z.string().min(1),
        kind: z.enum(["image", "video", "audio", "pdf", "3d", "other"]).optional(),
        tags: z.string().optional(),
        categories: z.string().optional(),
        bucketId: z.string().uuid().optional(),
        sizeMin: z.number().positive().optional(),
        sizeMax: z.number().positive().optional(),
        limit: z.number().min(1).max(100).optional(),
        offset: z.number().min(0).optional(),
      });
      const { q, kind, tags, categories, bucketId, sizeMin, sizeMax, limit, offset } = schema.parse(rawParams);

      // §5.8: delegate query construction to the canonical @medialocker/media
      // helpers instead of a divergent inline query. buildSearchQuery scopes by
      // buckets.org_id, reads tsv from the joined search_index, and parameterizes
      // every value; sanitizeSearchQuery turns the raw query into a safe
      // to_tsquery expression (prefix-matched). This keeps MCP search behavior
      // identical to the API/UI path.
      const filters: SearchFilters = {
        kind: kind || undefined,
        tags: tags ? String(tags).split(",").map((t: string) => t.trim()).filter(Boolean) : undefined,
        categories: categories ? String(categories).split(",").map((c: string) => c.trim()).filter(Boolean) : undefined,
        bucketId: bucketId || undefined,
        sizeMin: sizeMin !== undefined ? sizeMin : undefined,
        sizeMax: sizeMax !== undefined ? sizeMax : undefined,
      };

      if (auth.bucketScope) {
        filters.bucketName = auth.bucketScope;
      }

      const { sql: baseSql, params: baseParams } = buildSearchQuery(auth.orgId, q, filters);

      // Pagination is appended here (buildSearchQuery returns an unbounded query).
      // Clamp to safe numeric bounds and parameterize so they can't inject.
      const queryLimit = Math.min(Math.max(1, limit ?? 50), 100);
      const queryOffset = Math.max(0, offset ?? 0);
      const pagedParams = [...baseParams, queryLimit, queryOffset];
      const pagedSql = `${baseSql} LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`;

      const items = await sql.unsafe(pagedSql, pagedParams as any[]);

      return { items, query: q, sanitizedQuery: sanitizeSearchQuery(q), limit: queryLimit, offset: queryOffset };
    },
  });
}
