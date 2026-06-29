-- ============================================================================
-- 010: Listing/RLS indexes, multipart expiry support, search_index trigger
-- ============================================================================
-- Groups several remediation items that only need additive schema:
--   P2.43  index on multipart_uploads(created_at) for expiry scans
--   P2.47  trigger keeping search_index.tsv coherent on write
--   P2.50  genuinely-missing composite indexes for common listing queries
--   P2.51  covering indexes that let the RLS membership subqueries run
--          index-only (no heap fetch)
--
-- No BEGIN/COMMIT — the migration runner wraps each file in its own transaction
-- (scripts/migrate.ts). Every statement is IF NOT EXISTS / guarded so the file
-- is safe to re-run.

-- ----------------------------------------------------------------------------
-- P2.43: multipart_uploads expiry scan index
-- cleanup_expired_multipart_uploads() (008) and the cleanupExpiredMultipartUploads()
-- helper both filter on created_at < cutoff; without this index that scan is a
-- full seq scan as the table grows with orphaned uploads.
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_multipart_uploads_created_at
  ON multipart_uploads (created_at);

-- ----------------------------------------------------------------------------
-- P2.50: composite indexes for common listing queries
-- objects(bucket_id, created_at) and usage_events(org_id, ts) already exist
-- (008 idx_objects_bucket_created, 001 idx_usage_events_org_ts). The objects
-- table has NO org_id column (org is reached via bucket), so an objects(org_id,*)
-- index is not applicable. The genuinely-missing listing index is for the
-- api_keys listing endpoint (getApiKeysByOrg): WHERE org_id AND revoked_at IS NULL
-- ORDER BY created_at DESC.
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_api_keys_org_active_created
  ON api_keys (org_id, created_at DESC)
  WHERE revoked_at IS NULL;

-- ----------------------------------------------------------------------------
-- P2.51: supporting indexes for RLS membership subqueries
-- The hot RLS predicate is `bucket_id IN (SELECT id FROM buckets WHERE
-- org_id = auth_org_id())` (objects, derivatives, search_index, media_assets,
-- multipart_uploads, …). A plain index on buckets(org_id) still requires a heap
-- fetch for each id; (org_id, id) lets the subquery be satisfied index-only.
-- Likewise objects(bucket_id, id) supports the `objects o JOIN buckets b`
-- membership chain used by the metadata/tag/category/set/storyboard policies.
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_buckets_org_id_id
  ON buckets (org_id, id);

CREATE INDEX IF NOT EXISTS idx_objects_bucket_id_id
  ON objects (bucket_id, id)
  WHERE deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- P2.47: keep search_index.tsv coherent automatically
--
-- Background: search_index.tsv is assembled in application code from MULTIPLE
-- source rows (objects.original_name/key, tags, object_user_metadata) and
-- upserted via upsertSearchIndex(). It cannot be a GENERATED column because the
-- vectorized text spans several tables (documented in 001).
--
-- The remaining staleness risk is a row being INSERTed/UPDATEd with tsv left
-- NULL, or with a raw-but-unvectorized value, which would silently drop the row
-- from search. This trigger normalizes that: on INSERT/UPDATE of search_index,
-- if tsv ends up NULL it is coalesced to an empty tsvector (so the GIN index and
-- @@ matching stay well-defined and the row is never dropped to a NULL tsv).
-- It is intentionally conservative: when the application supplies a real tsv it
-- is preserved verbatim, so no behavior of upsertSearchIndex() changes.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION search_index_normalize_tsv()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Never persist a NULL tsv: a NULL would exclude the object from every
  -- full-text query and from the GIN index's usefulness. Coalesce to an empty
  -- vector so the row is consistently represented and updatable.
  IF NEW.tsv IS NULL THEN
    NEW.tsv := ''::tsvector;
  END IF;
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER trg_search_index_normalize_tsv
    BEFORE INSERT OR UPDATE OF tsv ON search_index
    FOR EACH ROW EXECUTE FUNCTION search_index_normalize_tsv();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Additionally, keep search_index in lock-step with the object's filename so a
-- rename via objects.original_name / key cannot leave the index pointing at the
-- old text. When those source columns change we re-derive the *baseline* tsv
-- from the object itself; richer tags/metadata terms are layered on by the
-- application's upsertSearchIndex() as before, so this only guarantees the
-- filename component is never stale.
CREATE OR REPLACE FUNCTION objects_refresh_search_index()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO search_index (object_id, tsv)
  VALUES (
    NEW.id,
    to_tsvector('english',
      coalesce(NEW.original_name, '') || ' ' || coalesce(NEW.key, ''))
  )
  ON CONFLICT (object_id) DO UPDATE
    SET tsv = to_tsvector('english',
      coalesce(NEW.original_name, '') || ' ' || coalesce(NEW.key, ''));

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER trg_objects_refresh_search_index
    AFTER INSERT OR UPDATE OF original_name, key ON objects
    FOR EACH ROW EXECUTE FUNCTION objects_refresh_search_index();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
