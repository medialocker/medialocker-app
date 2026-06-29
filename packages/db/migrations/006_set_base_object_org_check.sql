-- 006_set_base_object_org_check.sql
-- DB1: Cross-org guard for sets.base_object_id — enforces the base_object
-- belongs to a bucket owned by the same org_id.
-- DB2: Cross-org guard for categories.parent_id — enforces the parent
-- category belongs to the same org_id.

CREATE OR REPLACE FUNCTION check_set_base_object_org()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.base_object_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM objects o
      JOIN buckets b ON b.id = o.bucket_id
      WHERE o.id = NEW.base_object_id
        AND b.org_id = NEW.org_id
    ) THEN
      RAISE EXCEPTION 'sets.base_object_id must reference an object in a bucket owned by the same org';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_set_base_object_org
  BEFORE INSERT OR UPDATE ON sets
  FOR EACH ROW EXECUTE FUNCTION check_set_base_object_org();

CREATE OR REPLACE FUNCTION check_category_parent_org()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM categories
      WHERE id = NEW.parent_id
        AND org_id = NEW.org_id
    ) THEN
      RAISE EXCEPTION 'categories.parent_id must reference a category in the same org';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_category_parent_org
  BEFORE INSERT OR UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION check_category_parent_org();
