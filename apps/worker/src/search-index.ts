import type { Sql } from './db';

const DEFAULT_SEARCH_LANGUAGE = 'english';

export async function refreshSearchIndex(
  sql: Sql,
  objectId: string,
  language: string = DEFAULT_SEARCH_LANGUAGE,
): Promise<void> {
  await sql`
    INSERT INTO search_index (object_id, tsv)
    SELECT
      o.id,
      setweight(
        to_tsvector(
          ${language},
          regexp_replace(o.key, '^.*/', '')
        ),
        'A'
      )
      || setweight(
        to_tsvector(
          ${language},
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
          ${language},
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
