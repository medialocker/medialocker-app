-- ============================================================================
-- 009: Time-Series Table Retention and Cleanup Infrastructure
-- ============================================================================
-- Adds retention-cleanup functions for high-volume time-series tables
-- (usage_events, audit_log). Each function deletes up to a configurable
-- batch of rows older than `retain_days` in a single call; the caller
-- (a scheduled worker job) loops until the functions return 0.
-- Future migrations can introduce native PostgreSQL partitioning by
-- month if the per-org retention pattern proves insufficient.

-- 1. Cleanup function for usage_events
--    Deletes up to `batch_limit` rows older than `retain_days`.
--    Returns the number of rows deleted.
CREATE OR REPLACE FUNCTION cleanup_old_usage_events(
  retain_days integer DEFAULT 90,
  batch_limit integer DEFAULT 5000
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  cutoff     timestamptz;
  deleted    bigint;
BEGIN
  cutoff := now() - make_interval(days => retain_days);

  WITH batch AS (
    SELECT id FROM usage_events
    WHERE ts < cutoff
    LIMIT batch_limit
  )
  DELETE FROM usage_events USING batch
  WHERE usage_events.id = batch.id;

  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

-- 2. Cleanup function for audit_log
--    Deletes up to `batch_limit` rows older than `retain_days`.
CREATE OR REPLACE FUNCTION cleanup_old_audit_logs(
  retain_days integer DEFAULT 365,
  batch_limit integer DEFAULT 5000
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  cutoff     timestamptz;
  deleted    bigint;
BEGIN
  cutoff := now() - make_interval(days => retain_days);

  WITH batch AS (
    SELECT id FROM audit_log
    WHERE ts < cutoff
    LIMIT batch_limit
  )
  DELETE FROM audit_log USING batch
  WHERE audit_log.id = batch.id;

  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

-- 3. Composite indexes for efficient retention queries
--    Speeds up the cutoff-based subselect in cleanup functions and
--    also benefits listing endpoints that filter by org + time range.
CREATE INDEX IF NOT EXISTS idx_usage_events_org_ts_id
  ON usage_events (org_id, ts, id);

CREATE INDEX IF NOT EXISTS idx_audit_log_org_ts_id
  ON audit_log (org_id, ts, id);
