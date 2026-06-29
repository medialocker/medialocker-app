import { FastifyInstance } from "fastify";
import { z } from "zod";
import { validate } from "../middleware/validation.js";
import { requireScope } from "../middleware/auth.js";

const searchSchema = z.object({
  q: z.string().min(1),
  kind: z.enum(["image", "video", "audio", "pdf", "3d", "other"]).optional(),
  tags: z.string().optional(),
  categories: z.string().optional(),
  sets: z.string().optional(),
  storyboards: z.string().optional(),
  bucketId: z.string().uuid().optional(),
  sizeMin: z.coerce.number().int().min(0).optional(),
  sizeMax: z.coerce.number().int().min(0).optional(),
  // P2.13: date range filters must be valid ISO-8601 timestamps. Rejecting
  // anything else up front means the value is both well-formed and safe to bind
  // as a `timestamptz` parameter (no malformed-cast errors leaking from PG).
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  set: z.string().uuid().optional(),
  storyboard: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/search",
    { preHandler: [validate({ query: searchSchema }), requireScope("read")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const q = (request as any).validatedQuery as z.infer<typeof searchSchema>;

      // P2.12: build the WHERE clause from postgres.js tagged-template fragments
      // so NO user-supplied value is ever string-interpolated into raw SQL. The
      // previous version concatenated `$N` placeholders and shipped them through
      // `sql.unsafe`, which is brittle (any drift between placeholder count and
      // params throws at bind time) and trivially mis-usable. Every filter value
      // below — including the tsquery term, the split tag/category/set/storyboard
      // name arrays, and the ISO date bounds — is a bound parameter.
      const filters = [
        sql`o.deleted_at IS NULL`,
        sql`b.org_id = ${auth.orgId}`,
        sql`si.tsv @@ plainto_tsquery('english', ${q.q})`,
      ];

      if (q.kind) filters.push(sql`ma.kind = ${q.kind}`);
      if (q.bucketId) filters.push(sql`o.bucket_id = ${q.bucketId}`);
      if (q.sizeMin !== undefined) filters.push(sql`o.size >= ${q.sizeMin}`);
      if (q.sizeMax !== undefined) filters.push(sql`o.size <= ${q.sizeMax}`);
      // dateFrom/dateTo are validated as ISO timestamps (P2.13); bind + cast.
      if (q.dateFrom) filters.push(sql`o.created_at >= ${q.dateFrom}::timestamptz`);
      if (q.dateTo) filters.push(sql`o.created_at <= ${q.dateTo}::timestamptz`);

      if (q.tags) {
        const tagNames = q.tags.split(",").map((t) => t.trim()).filter(Boolean);
        if (tagNames.length > 0) {
          filters.push(sql`EXISTS (
            SELECT 1 FROM object_tags ot
            JOIN tags t ON t.id = ot.tag_id
            WHERE ot.object_id = o.id AND t.name = ANY(${tagNames})
          )`);
        }
      }

      if (q.categories) {
        const categoryNames = q.categories.split(",").map((c) => c.trim()).filter(Boolean);
        if (categoryNames.length > 0) {
          filters.push(sql`EXISTS (
            SELECT 1 FROM object_categories oc
            JOIN categories c ON c.id = oc.category_id
            WHERE oc.object_id = o.id AND c.name = ANY(${categoryNames})
          )`);
        }
      }

      if (q.sets) {
        const setNames = q.sets.split(",").map((s) => s.trim()).filter(Boolean);
        if (setNames.length > 0) {
          filters.push(sql`EXISTS (
            SELECT 1 FROM set_items sit2
            JOIN sets s2 ON s2.id = sit2.set_id
            WHERE sit2.object_id = o.id AND s2.name = ANY(${setNames})
          )`);
        }
      }

      if (q.storyboards) {
        const sbNames = q.storyboards.split(",").map((s) => s.trim()).filter(Boolean);
        if (sbNames.length > 0) {
          filters.push(sql`EXISTS (
            SELECT 1 FROM storyboard_clips sc2
            JOIN storyboards sb2 ON sb2.id = sc2.storyboard_id
            WHERE sc2.object_id = o.id AND sb2.name = ANY(${sbNames})
          )`);
        }
      }

      if (q.set) {
        filters.push(sql`EXISTS (
          SELECT 1 FROM set_items sit3 WHERE sit3.object_id = o.id AND sit3.set_id = ${q.set}
        )`);
      }

      if (q.storyboard) {
        filters.push(sql`EXISTS (
          SELECT 1 FROM storyboard_clips sc3 WHERE sc3.object_id = o.id AND sc3.storyboard_id = ${q.storyboard}
        )`);
      }

      let where = filters[0]!;
      for (let i = 1; i < filters.length; i++) where = sql`${where} AND ${filters[i]!}`;

      const [countResult, items] = await Promise.all([
        sql<{ count: string }[]>`
          SELECT COUNT(*)::text as count
          FROM objects o
          JOIN buckets b ON b.id = o.bucket_id
          JOIN search_index si ON si.object_id = o.id
          LEFT JOIN media_assets ma ON ma.object_id = o.id
          WHERE ${where}
        `,
        sql`
          SELECT o.id, o.bucket_id, o.key, o.size, o.content_type, o.created_at,
                 b.name as bucket_name, ma.kind, ma.width, ma.height, ma.duration_ms
          FROM objects o
          JOIN buckets b ON b.id = o.bucket_id
          JOIN search_index si ON si.object_id = o.id
          LEFT JOIN media_assets ma ON ma.object_id = o.id
          WHERE ${where}
          ORDER BY o.created_at DESC
          LIMIT ${q.limit} OFFSET ${q.offset}
        `,
      ]);

      const total = parseInt((countResult as any)[0]?.count ?? "0", 10);

      const [kindsResult, tagsResult, categoriesResult, setsResult, storyboardsResult] =
        await Promise.all([
          sql<{ kind: string | null; cnt: string }[]>`
            SELECT ma.kind, COUNT(*)::text as cnt
            FROM objects o
            JOIN buckets b ON b.id = o.bucket_id
            JOIN search_index si ON si.object_id = o.id
            LEFT JOIN media_assets ma ON ma.object_id = o.id
            WHERE ${where}
            GROUP BY ma.kind
          `,
          sql<{ name: string; cnt: string }[]>`
            SELECT t.name, COUNT(*)::text as cnt
            FROM objects o
            JOIN buckets b ON b.id = o.bucket_id
            JOIN search_index si ON si.object_id = o.id
            LEFT JOIN media_assets ma ON ma.object_id = o.id
            JOIN object_tags ot ON ot.object_id = o.id
            JOIN tags t ON t.id = ot.tag_id
            WHERE ${where}
            GROUP BY t.name
          `,
          sql<{ name: string; cnt: string }[]>`
            SELECT c.name, COUNT(*)::text as cnt
            FROM objects o
            JOIN buckets b ON b.id = o.bucket_id
            JOIN search_index si ON si.object_id = o.id
            LEFT JOIN media_assets ma ON ma.object_id = o.id
            JOIN object_categories oc ON oc.object_id = o.id
            JOIN categories c ON c.id = oc.category_id
            WHERE ${where}
            GROUP BY c.name
          `,
          sql<{ name: string; id: string; cnt: string }[]>`
            SELECT s.name, s.id, COUNT(*)::text as cnt
            FROM objects o
            JOIN buckets b ON b.id = o.bucket_id
            JOIN search_index si ON si.object_id = o.id
            LEFT JOIN media_assets ma ON ma.object_id = o.id
            JOIN set_items sit ON sit.object_id = o.id
            JOIN sets s ON s.id = sit.set_id
            WHERE ${where}
            GROUP BY s.name, s.id
          `,
          sql<{ name: string; id: string; cnt: string }[]>`
            SELECT sb.name, sb.id, COUNT(*)::text as cnt
            FROM objects o
            JOIN buckets b ON b.id = o.bucket_id
            JOIN search_index si ON si.object_id = o.id
            LEFT JOIN media_assets ma ON ma.object_id = o.id
            JOIN storyboard_clips sc ON sc.object_id = o.id
            JOIN storyboards sb ON sb.id = sc.storyboard_id
            WHERE ${where}
            GROUP BY sb.name, sb.id
          `,
        ]);

      function toRecord<T extends { name?: string; cnt: string }>(
        rows: T[],
        keyFn: (r: T) => string | null | undefined,
      ): Record<string, number> {
        const rec: Record<string, number> = {};
        for (const row of rows) {
          const key = keyFn(row);
          if (key) rec[key] = parseInt(row.cnt, 10);
        }
        return rec;
      }

      const kinds: Record<string, number> = {};
      for (const row of kindsResult) {
        if (row.kind) kinds[row.kind] = parseInt(row.cnt, 10);
      }

      const tags = toRecord(tagsResult, (r) => r.name);
      const categories = toRecord(categoriesResult, (r) => r.name);
      const sets = toRecord(setsResult, (r) => r.name);
      const storyboards = toRecord(storyboardsResult, (r) => r.name);

      return {
        items,
        total,
        limit: q.limit,
        offset: q.offset,
        facets: { kinds, tags, categories, sets, storyboards },
      };
    },
  );
}
