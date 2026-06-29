-- 003_api_key_name_and_indexes.sql
--
-- Forward-only, idempotent. Adds the human-friendly `name` that the create-key
-- API already accepts but never persisted (the dashboard surfaced the raw
-- access_key_id as the name as a result). Backfills existing rows with their
-- access_key_id so the column is never null in the UI.
--
-- NOTE: the migration runner wraps each file in its own transaction, so this
-- file intentionally contains no BEGIN/COMMIT.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS name TEXT;
UPDATE api_keys SET name = access_key_id WHERE name IS NULL;

-- Speeds up the per-object derivative lookup added for thumbnail serving
-- (GET /api/media/:id/thumbnail). Non-unique; coexists with derivatives_unique.
CREATE INDEX IF NOT EXISTS idx_derivatives_object_type ON derivatives (object_id, type);
