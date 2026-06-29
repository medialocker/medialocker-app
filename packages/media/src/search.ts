export interface SearchFilters {
  kind?: string;
  tags?: string[];
  categories?: string[];
  sizeMin?: number;
  sizeMax?: number;
  dateMin?: string;
  dateMax?: string;
  bucketId?: string;
  bucketName?: string;
  setId?: string;
  storyboardId?: string;
}

export function sanitizeSearchQuery(q: string): string {
  // Keep unicode letters/numbers (not just ASCII \w) so accented and non-Latin
  // queries aren't stripped to nothing. Underscore/hyphen/at/dot are preserved.
  // Returns plain text safe for plainto_tsquery (no tsquery operators).
  return q
    .replace(/[^\p{L}\p{N}_\s\-@.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildSearchQuery(
  orgId: string,
  q: string,
  filters: SearchFilters,
): { sql: string; params: unknown[] } {
  // objects has no org_id (tenancy is via its bucket) and no tsv (that lives in
  // search_index). Scope by buckets.org_id and read tsv from the joined index.
  const conditions: string[] = ['b.org_id = $1'];
  const params: unknown[] = [orgId];
  let paramIndex = 2;

  conditions.push('o.deleted_at IS NULL');

  if (q.trim()) {
    const sanitized = sanitizeSearchQuery(q);
    if (sanitized) {
      conditions.push(
        `sidx.tsv @@ plainto_tsquery('english', $${paramIndex})`,
      );
      params.push(sanitized);
      paramIndex++;
    }
  }

  if (filters.kind) {
    conditions.push(`ma.kind = $${paramIndex}`);
    params.push(filters.kind);
    paramIndex++;
  }

  if (filters.tags && filters.tags.length > 0) {
    conditions.push(
      `EXISTS (SELECT 1 FROM object_tags ot JOIN tags t ON t.id = ot.tag_id WHERE ot.object_id = o.id AND t.slug = ANY($${paramIndex}::text[]))`,
    );
    params.push(filters.tags);
    paramIndex++;
  }

  if (filters.categories && filters.categories.length > 0) {
    conditions.push(
      `EXISTS (SELECT 1 FROM object_categories oc JOIN categories c ON c.id = oc.category_id WHERE oc.object_id = o.id AND c.slug = ANY($${paramIndex}::text[]))`,
    );
    params.push(filters.categories);
    paramIndex++;
  }

  if (filters.sizeMin !== undefined) {
    conditions.push(`o.size >= $${paramIndex}`);
    params.push(filters.sizeMin);
    paramIndex++;
  }

  if (filters.sizeMax !== undefined) {
    conditions.push(`o.size <= $${paramIndex}`);
    params.push(filters.sizeMax);
    paramIndex++;
  }

  if (filters.dateMin) {
    conditions.push(`o.created_at >= $${paramIndex}::timestamptz`);
    params.push(filters.dateMin);
    paramIndex++;
  }

  if (filters.dateMax) {
    conditions.push(`o.created_at <= $${paramIndex}::timestamptz`);
    params.push(filters.dateMax);
    paramIndex++;
  }

  if (filters.bucketId) {
    conditions.push(`o.bucket_id = $${paramIndex}`);
    params.push(filters.bucketId);
    paramIndex++;
  }

  if (filters.bucketName) {
    conditions.push(`b.name = $${paramIndex}`);
    params.push(filters.bucketName);
    paramIndex++;
  }

  if (filters.setId) {
    conditions.push(
      `EXISTS (SELECT 1 FROM set_items si WHERE si.object_id = o.id AND si.set_id = $${paramIndex})`,
    );
    params.push(filters.setId);
    paramIndex++;
  }

  if (filters.storyboardId) {
    conditions.push(
      `EXISTS (SELECT 1 FROM storyboard_clips sc WHERE sc.object_id = o.id AND sc.storyboard_id = $${paramIndex})`,
    );
    params.push(filters.storyboardId);
    paramIndex++;
  }

  const where = conditions.join(' AND ');

  const sql = `
    SELECT o.id, o.bucket_id, o.key, o.size, o.content_type, o.etag,
           o.created_at, b.org_id, b.name AS bucket_name,
           ma.kind, ma.width, ma.height, ma.duration_ms, ma.codec, ma.frame_rate
    FROM objects o
    JOIN buckets b ON b.id = o.bucket_id
    LEFT JOIN search_index sidx ON sidx.object_id = o.id
    LEFT JOIN media_assets ma ON ma.object_id = o.id
    WHERE ${where}
    ORDER BY o.created_at DESC
  `;

  return { sql, params };
}
