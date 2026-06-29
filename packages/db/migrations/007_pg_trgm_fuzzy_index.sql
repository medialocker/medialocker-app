-- 007_pg_trgm_fuzzy_index.sql
-- DB5: Add pg_trgm GIN indexes for fuzzy/text search support.
-- The pg_trgm extension was enabled in 001. This migration adds
-- trigram indexes on the text columns used for fuzzy search.

-- Fuzzy search on object keys (filenames) via ILIKE / % wildcard
CREATE INDEX IF NOT EXISTS idx_objects_key_trgm
  ON objects USING GIN (key gin_trgm_ops);

-- Fuzzy search on original filenames
CREATE INDEX IF NOT EXISTS idx_objects_original_name_trgm
  ON objects USING GIN (original_name gin_trgm_ops);

-- Fuzzy search on tag names
CREATE INDEX IF NOT EXISTS idx_tags_name_trgm
  ON tags USING GIN (name gin_trgm_ops);

-- Fuzzy search on category names
CREATE INDEX IF NOT EXISTS idx_categories_name_trgm
  ON categories USING GIN (name gin_trgm_ops);

-- Fuzzy search on set names
CREATE INDEX IF NOT EXISTS idx_sets_name_trgm
  ON sets USING GIN (name gin_trgm_ops);
