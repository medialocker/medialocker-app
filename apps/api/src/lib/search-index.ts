import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

/**
 * Rebuilds the search_index tsvector for a single object from its
 * filename (basename of key), its tag names, and its user metadata values.
 *
 * Implemented as a single, idempotent, race-safe statement: every input is
 * derived via sub-selects keyed on object_id, then upserted on the UNIQUE
 * search_index.object_id constraint. Safe to call after any mutation that
 * affects an object's searchable text (tags, categories, user metadata).
 */
export async function refreshSearchIndex(sql: Sql, objectId: string): Promise<void> {
  await sql`
    INSERT INTO search_index (object_id, tsv)
    SELECT
      o.id,
      setweight(
        to_tsvector(
          'english',
          regexp_replace(o.key, '^.*/', '')
        ),
        'A'
      )
      || setweight(
        to_tsvector(
          'english',
          COALESCE(
            (SELECT string_agg(t.name, ' ')
               FROM object_tags ot
               JOIN tags t ON t.id = ot.tag_id
              WHERE ot.object_id = o.id),
            ''
          )
        ),
        'B'
      )
      || setweight(
        to_tsvector(
          'english',
          COALESCE(
            (SELECT string_agg(oum.value, ' ')
               FROM object_user_metadata oum
              WHERE oum.object_id = o.id),
            ''
          )
        ),
        'C'
      ) AS tsv
    FROM objects o
    WHERE o.id = ${objectId}
    ON CONFLICT (object_id) DO UPDATE SET tsv = EXCLUDED.tsv
  `;
}
