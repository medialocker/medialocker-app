-- DB5: junction-table RLS verified only the PARENT (tag / category / set /
-- storyboard) org, never the linked OBJECT. A caller could therefore link their own
-- tag/category/set/storyboard to ANOTHER org's object_id. Tighten each policy to
-- ALSO require the object to belong to the caller's org. Objects are org-scoped via
-- buckets.org_id (the objects table has no org_id column).
--
-- `FOR ALL USING (...)` with no explicit WITH CHECK reuses the USING expression as
-- the INSERT/UPDATE check, so a cross-tenant link is blocked on write too.
--
-- No BEGIN/COMMIT — the migration runner wraps each file in its own transaction (7.1).

DROP POLICY IF EXISTS org_isolation ON object_tags;
CREATE POLICY org_isolation ON object_tags
  FOR ALL USING (
    tag_id IN (SELECT id FROM tags WHERE org_id = auth_org_id())
    AND object_id IN (
      SELECT o.id FROM objects o JOIN buckets b ON b.id = o.bucket_id
       WHERE b.org_id = auth_org_id()
    )
  );

DROP POLICY IF EXISTS org_isolation ON object_categories;
CREATE POLICY org_isolation ON object_categories
  FOR ALL USING (
    category_id IN (SELECT id FROM categories WHERE org_id = auth_org_id())
    AND object_id IN (
      SELECT o.id FROM objects o JOIN buckets b ON b.id = o.bucket_id
       WHERE b.org_id = auth_org_id()
    )
  );

DROP POLICY IF EXISTS org_isolation ON set_items;
CREATE POLICY org_isolation ON set_items
  FOR ALL USING (
    set_id IN (SELECT id FROM sets WHERE org_id = auth_org_id())
    AND object_id IN (
      SELECT o.id FROM objects o JOIN buckets b ON b.id = o.bucket_id
       WHERE b.org_id = auth_org_id()
    )
  );

DROP POLICY IF EXISTS org_isolation ON storyboard_clips;
CREATE POLICY org_isolation ON storyboard_clips
  FOR ALL USING (
    storyboard_id IN (SELECT id FROM storyboards WHERE org_id = auth_org_id())
    AND object_id IN (
      SELECT o.id FROM objects o JOIN buckets b ON b.id = o.bucket_id
       WHERE b.org_id = auth_org_id()
    )
  );
