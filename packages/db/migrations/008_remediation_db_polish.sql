-- 008_remediation_db_polish.sql
-- Phase F: database polish items F05-F09, F11-F12.
-- F05: buckets.name unique per org (composite partial index)
-- F06: UNIQUE index on buckets.minio_bucket
-- F07: cross-org triggers on junction tables (object_tags, set_items,
--      object_categories, storyboard_clips)
-- F08: cross-org ownership guard trigger on derivatives
-- F09: capacity invariant CHECK constraint (non-auto orgs)
-- F11: multipart upload expiry cleanup function
-- F12: composite indexes for common listing queries
--
-- No BEGIN/COMMIT — the migration runner wraps each file in its own
-- transaction (packages/db/scripts/migrate.ts).

-- =============================================================================
-- F05: Replace global UNIQUE on buckets.name with per-org composite partial index
-- =============================================================================

DROP INDEX IF EXISTS buckets_name_unique;
CREATE UNIQUE INDEX IF NOT EXISTS buckets_name_org_unique
  ON buckets (org_id, name)
  WHERE deleted_at IS NULL;

-- =============================================================================
-- F06: Add UNIQUE index on buckets.minio_bucket
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS buckets_minio_bucket_unique
  ON buckets (minio_bucket);

-- =============================================================================
-- F07: Cross-org triggers on junction tables
-- These prevent the service role (which bypasses RLS) from linking an object
-- from one org with a tag / set / category / storyboard from another org.
-- =============================================================================

-- --- object_tags ---

CREATE OR REPLACE FUNCTION check_object_tags_cross_org()
RETURNS TRIGGER AS $$
DECLARE
  tag_org   UUID;
  obj_org   UUID;
BEGIN
  SELECT org_id INTO tag_org FROM tags WHERE id = NEW.tag_id;

  SELECT b.org_id INTO obj_org
    FROM objects o
    JOIN buckets b ON b.id = o.bucket_id
   WHERE o.id = NEW.object_id;

  IF tag_org IS NULL THEN
    RAISE EXCEPTION 'tag_id % not found', NEW.tag_id;
  END IF;
  IF obj_org IS NULL THEN
    RAISE EXCEPTION 'object_id % not found in any active bucket', NEW.object_id;
  END IF;
  IF tag_org <> obj_org THEN
    RAISE EXCEPTION 'object_tags: object (org %) and tag (org %) must belong to the same org',
      obj_org, tag_org;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_check_object_tags_cross_org
    BEFORE INSERT OR UPDATE ON object_tags
    FOR EACH ROW EXECUTE FUNCTION check_object_tags_cross_org();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- --- set_items ---

CREATE OR REPLACE FUNCTION check_set_items_cross_org()
RETURNS TRIGGER AS $$
DECLARE
  set_org  UUID;
  obj_org  UUID;
BEGIN
  SELECT org_id INTO set_org FROM sets WHERE id = NEW.set_id;

  SELECT b.org_id INTO obj_org
    FROM objects o
    JOIN buckets b ON b.id = o.bucket_id
   WHERE o.id = NEW.object_id;

  IF set_org IS NULL THEN
    RAISE EXCEPTION 'set_id % not found', NEW.set_id;
  END IF;
  IF obj_org IS NULL THEN
    RAISE EXCEPTION 'object_id % not found in any active bucket', NEW.object_id;
  END IF;
  IF set_org <> obj_org THEN
    RAISE EXCEPTION 'set_items: object (org %) and set (org %) must belong to the same org',
      obj_org, set_org;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_check_set_items_cross_org
    BEFORE INSERT OR UPDATE ON set_items
    FOR EACH ROW EXECUTE FUNCTION check_set_items_cross_org();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- --- object_categories ---

CREATE OR REPLACE FUNCTION check_object_categories_cross_org()
RETURNS TRIGGER AS $$
DECLARE
  cat_org  UUID;
  obj_org  UUID;
BEGIN
  SELECT org_id INTO cat_org FROM categories WHERE id = NEW.category_id;

  SELECT b.org_id INTO obj_org
    FROM objects o
    JOIN buckets b ON b.id = o.bucket_id
   WHERE o.id = NEW.object_id;

  IF cat_org IS NULL THEN
    RAISE EXCEPTION 'category_id % not found', NEW.category_id;
  END IF;
  IF obj_org IS NULL THEN
    RAISE EXCEPTION 'object_id % not found in any active bucket', NEW.object_id;
  END IF;
  IF cat_org <> obj_org THEN
    RAISE EXCEPTION 'object_categories: object (org %) and category (org %) must belong to the same org',
      obj_org, cat_org;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_check_object_categories_cross_org
    BEFORE INSERT OR UPDATE ON object_categories
    FOR EACH ROW EXECUTE FUNCTION check_object_categories_cross_org();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- --- storyboard_clips ---

CREATE OR REPLACE FUNCTION check_storyboard_clips_cross_org()
RETURNS TRIGGER AS $$
DECLARE
  sb_org   UUID;
  obj_org  UUID;
BEGIN
  SELECT org_id INTO sb_org FROM storyboards WHERE id = NEW.storyboard_id;

  SELECT b.org_id INTO obj_org
    FROM objects o
    JOIN buckets b ON b.id = o.bucket_id
   WHERE o.id = NEW.object_id;

  IF sb_org IS NULL THEN
    RAISE EXCEPTION 'storyboard_id % not found', NEW.storyboard_id;
  END IF;
  IF obj_org IS NULL THEN
    RAISE EXCEPTION 'object_id % not found in any active bucket', NEW.object_id;
  END IF;
  IF sb_org <> obj_org THEN
    RAISE EXCEPTION 'storyboard_clips: object (org %) and storyboard (org %) must belong to the same org',
      obj_org, sb_org;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_check_storyboard_clips_cross_org
    BEFORE INSERT OR UPDATE ON storyboard_clips
    FOR EACH ROW EXECUTE FUNCTION check_storyboard_clips_cross_org();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- F08: Cross-org ownership guard on derivatives
-- Verify the derivative's object_id belongs to a valid org chain (object →
-- active bucket → existing org). Prevents the service role from creating
-- derivatives for objects in soft-deleted buckets.
-- =============================================================================

CREATE OR REPLACE FUNCTION check_derivatives_object_org()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM objects o
      JOIN buckets b ON b.id = o.bucket_id
     WHERE o.id = NEW.object_id
       AND b.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'derivatives.object_id % must reference an object in an active (non-deleted) bucket',
      NEW.object_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_check_derivatives_object_org
    BEFORE INSERT OR UPDATE ON derivatives
    FOR EACH ROW EXECUTE FUNCTION check_derivatives_object_org();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- F09: Capacity invariant CHECK constraint
-- Non-auto orgs: used_bytes <= allocated_bytes (hard enforcement).
-- Auto-enabled orgs: OR auto_enabled = true allows temporary overage until
-- the next auto-capacity add fires.
-- =============================================================================

DO $$ BEGIN
  ALTER TABLE capacity ADD CONSTRAINT capacity_used_lte_allocated
    CHECK (auto_enabled = true OR used_bytes <= allocated_bytes);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- F11: Multipart upload expiry cleanup function
-- Deletes multipart_uploads older than 7 days (cascades to multipart_parts).
-- Returns deleted rows so the caller can release MinIO storage.
-- Intended to be called by a scheduled worker job.
-- =============================================================================

CREATE OR REPLACE FUNCTION cleanup_expired_multipart_uploads()
RETURNS TABLE(
  uploaded_id     TEXT,
  uploaded_key    TEXT,
  uploaded_bucket  UUID
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
    DELETE FROM multipart_uploads
     WHERE created_at < now() - INTERVAL '7 days'
    RETURNING upload_id, key, bucket_id;
END;
$$;

-- =============================================================================
-- F12: Composite indexes for common listing queries
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_objects_bucket_created
  ON objects (bucket_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_usage_events_org_type_ts
  ON usage_events (org_id, type, ts);
