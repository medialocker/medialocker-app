-- 002_fix_schema_drift.sql
--
-- Forward-only, idempotent reconciliation of the schema with the code (§21).
-- 001 was corrected in place for fresh installs; this migration brings any
-- environment that ALREADY applied the original 001 up to the same state. Every
-- statement is guarded (IF [NOT] EXISTS) so it is a no-op on a fresh DB where
-- 001 already created everything.
--
-- NOTE: the migration runner wraps each file in its own transaction, so this
-- file intentionally contains no BEGIN/COMMIT.

-- plans: Stripe product + add-on price ids (billing/plans.ts, setup-stripe).
ALTER TABLE plans ADD COLUMN IF NOT EXISTS stripe_product_id TEXT;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS stripe_addon_price_id TEXT;

-- billing_addons: recorded cost for spend-cycle accounting (capacity-addons.ts).
ALTER TABLE billing_addons ADD COLUMN IF NOT EXISTS cost_cents INTEGER NOT NULL DEFAULT 0;

-- subscriptions: Stripe customer id (webhook provisioning + customer portal).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

-- subscriptions: one per org (§20 #5) — required as the ON CONFLICT (org_id)
-- target used by both webhook handlers. Replaces the original NON-unique index.
-- If a legacy DB somehow has >1 subscription for an org, this CREATE will fail;
-- dedup to one row per org, then re-run.
DROP INDEX IF EXISTS idx_subscriptions_org_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_org_id ON subscriptions(org_id);

-- derivatives: allow multiple variants per object (one per aspect ratio /
-- minio_key) and match the worker upserts' ON CONFLICT (object_id, type,
-- minio_key). Widening the key is non-destructive (old key forbade duplicates).
DROP INDEX IF EXISTS derivatives_unique;
CREATE UNIQUE INDEX IF NOT EXISTS derivatives_unique ON derivatives (object_id, type, minio_key);

-- service_secrets: durable encrypted store for rotated internal secrets (§5/§17).
CREATE TABLE IF NOT EXISTS service_secrets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  version_id TEXT NOT NULL,
  value_enc TEXT NOT NULL,
  stages TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, version_id)
);
CREATE INDEX IF NOT EXISTS idx_service_secrets_name ON service_secrets(name);

-- webhook_events: Stripe webhook idempotency ledger (§26).
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deny-all RLS on the two non-tenant internal tables (defense in depth: only
-- the BYPASSRLS service role reads them; the Supabase client path cannot).
ALTER TABLE service_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;

-- The blanket grant in 001 does not re-run for an already-migrated DB, so grant
-- the new tables to the service role explicitly (idempotent).
GRANT ALL PRIVILEGES ON service_secrets TO medialocker_service;
GRANT ALL PRIVILEGES ON webhook_events TO medialocker_service;
