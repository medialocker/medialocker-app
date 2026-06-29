-- DB2: guard monetary + storage columns against negative values at the DB level.
-- Only `capacity` had CHECK constraints (added inline in 001); extend the
-- same protection to the other quantity columns.
--
-- P2.42 IDEMPOTENCY GUARD: migration 001 (lines ~675-684) ALSO adds equivalent
-- non-negative CHECK constraints under different names (e.g.
-- `objects_size_nonnegative` vs this file's `objects_size_nonneg`). On a fresh
-- install both files run, which previously left two redundant CHECK constraints
-- per column. Each ADD below is now wrapped in a DO block that:
--   (a) is a no-op (`duplicate_object`) if this file's own constraint name
--       already exists (re-run safety), AND
--   (b) is SKIPPED entirely when an equivalent constraint from 001 is already
--       present on the column, so we never create a duplicate logical check.
-- The net effect: exactly one non-negative CHECK per column after a full run,
-- and no error on a fresh full migration run.
--
-- DELIBERATELY EXCLUDED: usage_events.bytes — it is a SIGNED delta (a delete emits
-- a negative stored_delta), so a `>= 0` constraint would be wrong there.
--
-- NOTE: no BEGIN/COMMIT here — the migration runner wraps each file in its own
-- transaction (see scripts/migrate.ts).

-- Helper: add `constraint_name` enforcing `check_expr` on `tbl`, but only if no
-- CHECK constraint already covers that column (i.e. 001 did not already add an
-- equivalently-named-or-purposed one for the same column). We detect a
-- pre-existing equivalent by looking for ANY check constraint on the table whose
-- name matches the `<table>_<column>_nonneg%` family that 001 / this file use.
DO $$
DECLARE
  spec RECORD;
BEGIN
  FOR spec IN
    SELECT *
    FROM (VALUES
      ('plans',             'plans_per_gb_price_cents_nonneg',        'per_gb_price_cents >= 0', 'per_gb_price_cents'),
      ('billing_addons',    'billing_addons_gb_nonneg',               'gb >= 0',                 'gb'),
      ('billing_addons',    'billing_addons_cost_cents_nonneg',       'cost_cents >= 0',         'cost_cents'),
      ('objects',           'objects_size_nonneg',                    'size >= 0',               'size'),
      ('derivatives',       'derivatives_bytes_nonneg',               'bytes >= 0',              'bytes'),
      ('multipart_uploads', 'multipart_uploads_reserved_nonneg',      'total_bytes_reserved >= 0', 'total_bytes_reserved'),
      ('multipart_parts',   'multipart_parts_size_nonneg',            'size >= 0',               'size'),
      ('usage_rollups',     'usage_rollups_stored_bytes_max_nonneg',  'stored_bytes_max >= 0',   'stored_bytes_max'),
      ('usage_rollups',     'usage_rollups_egress_bytes_nonneg',      'egress_bytes >= 0',       'egress_bytes')
    ) AS t(tbl, cname, check_expr, col)
  LOOP
    -- Skip if an equivalent non-negative CHECK already exists on this column
    -- (added by 001 under its `*_nonnegative` naming, or already by this file).
    IF EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class      rel ON rel.oid = c.conrelid
      JOIN pg_namespace  ns  ON ns.oid = rel.relnamespace
      WHERE c.contype = 'c'
        AND ns.nspname = 'public'
        AND rel.relname = spec.tbl
        AND (
          c.conname = spec.cname
          OR pg_get_constraintdef(c.oid) ILIKE '%' || spec.col || '%>= 0%'
        )
    ) THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s)',
      spec.tbl, spec.cname, spec.check_expr
    );
  END LOOP;
END $$;
