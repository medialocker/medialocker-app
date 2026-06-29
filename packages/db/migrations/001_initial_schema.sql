-- 001_initial_schema.sql
-- MediaLocker full data model
--
-- NOTE: do not wrap this file in BEGIN/COMMIT. The migration runner
-- (packages/db/scripts/migrate.ts) already executes each migration inside a
-- single transaction via sql.begin(); a nested BEGIN/COMMIT here closes that
-- outer transaction early and fails on a real Postgres instance.

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Service role that bypasses RLS (backend services scope queries themselves).
-- No password is set here: the credential is assigned out-of-band by the
-- provisioning step (ALTER ROLE medialocker_service PASSWORD ...) reading from a
-- secret, so a real password is never committed to source control.
--
-- PORTABILITY: on Supabase Cloud the migration runs as `postgres`, which cannot
-- grant BYPASSRLS, so CREATE ROLE raises insufficient_privilege — we swallow it.
-- There the app instead connects as the schema-owner role (`postgres`), which
-- bypasses RLS automatically because no table uses FORCE ROW LEVEL SECURITY. On a
-- self-hosted/CI Postgres the connecting superuser CAN create the role, so it is.
DO $$ BEGIN
  CREATE ROLE medialocker_service WITH LOGIN BYPASSRLS;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'medialocker_service not created (insufficient privilege) — app will connect as the schema owner; continuing.';
END $$;

-- Enums
DO $$ BEGIN
  CREATE TYPE membership_role AS ENUM ('owner', 'admin', 'member');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE media_kind AS ENUM ('image', 'video', 'audio', 'pdf', '3d', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE derivative_type AS ENUM ('thumbnail', 'poster', 'sprite', 'variant');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE usage_event_type AS ENUM ('stored_delta', 'egress', 'request');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE subscription_status AS ENUM ('active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'trialing', 'unpaid', 'paused');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ========== Core Tenancy ==========

CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role membership_role NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE INDEX idx_memberships_user_id ON memberships(user_id);
CREATE INDEX idx_memberships_org_id ON memberships(org_id);

-- ========== Billing ==========

CREATE TABLE plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tier_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  included_gb NUMERIC NOT NULL,
  per_gb_price_cents INTEGER NOT NULL,
  stripe_product_id TEXT,
  stripe_price_id TEXT,
  stripe_addon_price_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT,
  plan_id UUID NOT NULL REFERENCES plans(id),
  status subscription_status NOT NULL DEFAULT 'active',
  current_period_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One subscription per org (§20 #5) — also the conflict target for the
-- webhook/billing upserts (`ON CONFLICT (org_id)`).
CREATE UNIQUE INDEX idx_subscriptions_org_id ON subscriptions(org_id);

CREATE TABLE capacity (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  allocated_bytes BIGINT NOT NULL DEFAULT 0 CHECK (allocated_bytes >= 0),
  used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  auto_enabled BOOLEAN NOT NULL DEFAULT false,
  increment_gb NUMERIC NOT NULL DEFAULT 10,
  threshold_pct INTEGER NOT NULL DEFAULT 80,
  max_monthly_spend_cents INTEGER DEFAULT 0,
  spend_this_cycle_cents INTEGER NOT NULL DEFAULT 0,
  -- Debounce window for auto-capacity: the timestamp of the last automated add,
  -- used to avoid adding capacity on every over-quota write (§8).
  last_auto_add_at TIMESTAMPTZ
);

CREATE TABLE billing_addons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_item_id TEXT NOT NULL,
  gb NUMERIC NOT NULL,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  prorated BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_billing_addons_org ON billing_addons(org_id);

-- Stripe webhook idempotency ledger (§26): the event id is the dedup key, so a
-- redelivered event is processed at most once. Not org-scoped (no RLS).
CREATE TABLE webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deny-all RLS (no policy): platform-internal ledger, service-role only.
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;

-- ========== Storage ==========

CREATE TABLE buckets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  minio_bucket TEXT NOT NULL,
  versioning_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX buckets_name_unique ON buckets (name) WHERE deleted_at IS NULL;
CREATE INDEX idx_buckets_org_id ON buckets(org_id);
CREATE INDEX idx_buckets_deleted_at ON buckets(deleted_at);

CREATE TABLE objects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bucket_id UUID NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  original_name TEXT,
  version_id TEXT,
  size BIGINT NOT NULL DEFAULT 0,
  etag TEXT,
  content_type TEXT,
  storage_class TEXT DEFAULT 'STANDARD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX objects_key_unique ON objects (bucket_id, key) WHERE deleted_at IS NULL;
CREATE INDEX idx_objects_bucket_id ON objects(bucket_id);
CREATE INDEX idx_objects_deleted_at ON objects(deleted_at);
CREATE INDEX idx_objects_key_trgm ON objects USING GIN(key gin_trgm_ops);

CREATE TABLE object_user_metadata (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE (object_id, key)
);

CREATE INDEX idx_object_user_metadata_object ON object_user_metadata(object_id);

CREATE TABLE multipart_uploads (
  upload_id TEXT PRIMARY KEY,
  bucket_id UUID REFERENCES buckets(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  total_bytes_reserved BIGINT NOT NULL DEFAULT 0,
  content_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_multipart_uploads_bucket ON multipart_uploads(bucket_id);

CREATE TABLE multipart_parts (
  upload_id TEXT NOT NULL REFERENCES multipart_uploads(upload_id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  size BIGINT NOT NULL DEFAULT 0,
  UNIQUE (upload_id, part_number)
);

CREATE INDEX idx_multipart_parts_upload ON multipart_parts(upload_id);

-- ========== Auth ==========

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT,
  access_key_id TEXT NOT NULL UNIQUE,
  secret_enc TEXT NOT NULL,
  bearer_lookup_hash TEXT NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  bucket_scope TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + '90 days'::INTERVAL),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_keys_org_id ON api_keys(org_id);
CREATE INDEX idx_api_keys_access_key_id ON api_keys(access_key_id);
CREATE INDEX idx_api_keys_bearer_hash ON api_keys(bearer_lookup_hash);
CREATE INDEX idx_api_keys_revoked_expires ON api_keys(revoked_at, expires_at);

-- ========== Internal secret rotation (§5/§17) ==========

-- Durable, versioned store for platform-internal secrets the worker rotates
-- (MinIO creds, internal signing secret). Values are AES-256-GCM ciphertext
-- (encrypted with API_KEY_ENC_KEY) — never plaintext. Not a tenant table
-- (no org_id): only the medialocker_service role can read it; no RLS.
CREATE TABLE service_secrets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  version_id TEXT NOT NULL,
  value_enc TEXT NOT NULL,
  stages TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, version_id)
);

CREATE INDEX idx_service_secrets_name ON service_secrets(name);

-- Deny-all RLS (no policy): only the BYPASSRLS service role may read secrets.
ALTER TABLE service_secrets ENABLE ROW LEVEL SECURITY;

-- ========== Media ==========

CREATE TABLE media_assets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  object_id UUID NOT NULL UNIQUE REFERENCES objects(id) ON DELETE CASCADE,
  kind media_kind NOT NULL DEFAULT 'other',
  width INTEGER,
  height INTEGER,
  duration_ms BIGINT,
  codec TEXT,
  frame_rate NUMERIC,
  has_audio BOOLEAN,
  probe_json JSONB
);

CREATE INDEX idx_media_assets_kind ON media_assets(kind);

CREATE TABLE tags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  UNIQUE (org_id, slug)
);

CREATE INDEX idx_tags_org_id ON tags(org_id);

CREATE TABLE object_tags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  UNIQUE (object_id, tag_id)
);

CREATE INDEX idx_object_tags_object ON object_tags(object_id);
CREATE INDEX idx_object_tags_tag ON object_tags(tag_id);

CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  parent_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  UNIQUE (org_id, slug)
);

CREATE INDEX idx_categories_org_id ON categories(org_id);
CREATE INDEX idx_categories_parent ON categories(parent_id);

CREATE TABLE object_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  UNIQUE (object_id, category_id)
);

CREATE INDEX idx_object_categories_object ON object_categories(object_id);
CREATE INDEX idx_object_categories_category ON object_categories(category_id);

CREATE TABLE sets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_object_id UUID REFERENCES objects(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sets_org_id ON sets(org_id);

CREATE TABLE set_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  set_id UUID NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  aspect_ratio TEXT,
  width INTEGER,
  height INTEGER,
  role TEXT,
  UNIQUE (set_id, object_id)
);

CREATE INDEX idx_set_items_set ON set_items(set_id);
CREATE INDEX idx_set_items_object ON set_items(object_id);

CREATE TABLE storyboards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_storyboards_org_id ON storyboards(org_id);

CREATE TABLE storyboard_clips (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  storyboard_id UUID NOT NULL REFERENCES storyboards(id) ON DELETE CASCADE,
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  note TEXT,
  UNIQUE (storyboard_id, position)
);

CREATE INDEX idx_storyboard_clips_storyboard ON storyboard_clips(storyboard_id);

CREATE TABLE derivatives (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  type derivative_type NOT NULL,
  minio_key TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  bytes BIGINT NOT NULL DEFAULT 0,
  billable BOOLEAN NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX derivatives_unique ON derivatives (object_id, type, minio_key);
CREATE INDEX idx_derivatives_object ON derivatives(object_id);

-- ========== Search ==========

-- search_index.tsv is worker-maintained (NOT GENERATED ALWAYS AS … STORED).
-- The TSVECTOR is built by the application layer from filename + tags + user
-- metadata and upserted via upsertSearchIndex() (packages/db/src/index.ts:570).
-- A generated column is infeasible because the text to vectorize comes from
-- multiple source rows (tags, object_user_metadata) and is assembled in
-- application code, not derived from columns within this single row.

CREATE TABLE search_index (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  object_id UUID NOT NULL UNIQUE REFERENCES objects(id) ON DELETE CASCADE,
  tsv TSVECTOR
);

CREATE INDEX idx_search_index_tsv ON search_index USING GIN(tsv);
CREATE INDEX idx_search_index_object ON search_index(object_id);

-- ========== Metering ==========

CREATE TABLE usage_events (
  id BIGSERIAL PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type usage_event_type NOT NULL,
  bytes BIGINT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_usage_events_org_ts ON usage_events(org_id, ts);
CREATE INDEX idx_usage_events_type ON usage_events(type);

CREATE TABLE usage_rollups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period DATE NOT NULL,
  stored_bytes_max BIGINT NOT NULL DEFAULT 0,
  egress_bytes BIGINT NOT NULL DEFAULT 0,
  request_count BIGINT NOT NULL DEFAULT 0,
  UNIQUE (org_id, period)
);

CREATE INDEX idx_usage_rollups_org_period ON usage_rollups(org_id, period);

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  ip TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_org_ts ON audit_log(org_id, ts);
CREATE INDEX idx_audit_log_action ON audit_log(action);

-- ========== RLS: helper function ==========

CREATE OR REPLACE FUNCTION auth_org_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  org_id UUID;
BEGIN
  org_id := COALESCE(
    current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'org_id',
    current_setting('request.jwt.claims', true)::jsonb ->> 'org_id'
  )::UUID;
  RETURN org_id;
END;
$$;

-- ========== RLS Policies ==========

-- For each tenant table: org_id = auth_org_id()

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON organizations;
CREATE POLICY org_isolation ON organizations
  FOR ALL USING (id = auth_org_id());

-- A user may only see/modify their own row (matched against the JWT subject).
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_self ON users;
CREATE POLICY user_self ON users
  FOR ALL USING (
    id = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
  );

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON memberships;
CREATE POLICY org_isolation ON memberships
  FOR ALL USING (org_id = auth_org_id());

-- Plans are global pricing: readable by anyone, writable only by the service
-- role (which bypasses RLS). No write policy => non-service roles cannot mutate.
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plans_read ON plans;
CREATE POLICY plans_read ON plans
  FOR SELECT USING (true);

-- Multipart upload state is org-scoped through its bucket.
ALTER TABLE multipart_uploads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON multipart_uploads;
CREATE POLICY org_isolation ON multipart_uploads
  FOR ALL USING (
    bucket_id IN (SELECT id FROM buckets WHERE org_id = auth_org_id())
  );

ALTER TABLE multipart_parts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON multipart_parts;
CREATE POLICY org_isolation ON multipart_parts
  FOR ALL USING (
    upload_id IN (
      SELECT upload_id FROM multipart_uploads
      WHERE bucket_id IN (SELECT id FROM buckets WHERE org_id = auth_org_id())
    )
  );

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON subscriptions;
CREATE POLICY org_isolation ON subscriptions
  FOR ALL USING (org_id = auth_org_id());

ALTER TABLE capacity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON capacity;
CREATE POLICY org_isolation ON capacity
  FOR ALL USING (org_id = auth_org_id());

ALTER TABLE billing_addons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON billing_addons;
CREATE POLICY org_isolation ON billing_addons
  FOR ALL USING (org_id = auth_org_id());

ALTER TABLE buckets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON buckets;
CREATE POLICY org_isolation ON buckets
  FOR ALL USING (org_id = auth_org_id());

ALTER TABLE objects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON objects;
CREATE POLICY org_isolation ON objects
  FOR ALL USING (
    bucket_id IN (SELECT id FROM buckets WHERE org_id = auth_org_id())
  );

ALTER TABLE object_user_metadata ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON object_user_metadata;
CREATE POLICY org_isolation ON object_user_metadata
  FOR ALL USING (
    object_id IN (
      SELECT o.id FROM objects o
      JOIN buckets b ON o.bucket_id = b.id
      WHERE b.org_id = auth_org_id()
    )
  );

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON api_keys;
CREATE POLICY org_isolation ON api_keys
  FOR ALL USING (org_id = auth_org_id());

ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON media_assets;
CREATE POLICY org_isolation ON media_assets
  FOR ALL USING (
    object_id IN (
      SELECT o.id FROM objects o
      JOIN buckets b ON o.bucket_id = b.id
      WHERE b.org_id = auth_org_id()
    )
  );

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON tags;
CREATE POLICY org_isolation ON tags
  FOR ALL USING (org_id = auth_org_id());

ALTER TABLE object_tags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON object_tags;
CREATE POLICY org_isolation ON object_tags
  FOR ALL USING (
    tag_id IN (SELECT id FROM tags WHERE org_id = auth_org_id())
    AND object_id IN (
      SELECT o.id FROM objects o
      JOIN buckets b ON o.bucket_id = b.id
      WHERE b.org_id = auth_org_id()
    )
  );

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON categories;
CREATE POLICY org_isolation ON categories
  FOR ALL USING (org_id = auth_org_id());

ALTER TABLE object_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON object_categories;
CREATE POLICY org_isolation ON object_categories
  FOR ALL USING (
    category_id IN (SELECT id FROM categories WHERE org_id = auth_org_id())
    AND object_id IN (
      SELECT o.id FROM objects o
      JOIN buckets b ON o.bucket_id = b.id
      WHERE b.org_id = auth_org_id()
    )
  );

ALTER TABLE sets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON sets;
CREATE POLICY org_isolation ON sets
  FOR ALL USING (org_id = auth_org_id());

ALTER TABLE set_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON set_items;
CREATE POLICY org_isolation ON set_items
  FOR ALL USING (
    set_id IN (SELECT id FROM sets WHERE org_id = auth_org_id())
    AND object_id IN (
      SELECT o.id FROM objects o
      JOIN buckets b ON o.bucket_id = b.id
      WHERE b.org_id = auth_org_id()
    )
  );

ALTER TABLE storyboards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON storyboards;
CREATE POLICY org_isolation ON storyboards
  FOR ALL USING (org_id = auth_org_id());

ALTER TABLE storyboard_clips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON storyboard_clips;
CREATE POLICY org_isolation ON storyboard_clips
  FOR ALL USING (
    storyboard_id IN (SELECT id FROM storyboards WHERE org_id = auth_org_id())
    AND object_id IN (
      SELECT o.id FROM objects o
      JOIN buckets b ON o.bucket_id = b.id
      WHERE b.org_id = auth_org_id()
    )
  );

ALTER TABLE derivatives ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON derivatives;
CREATE POLICY org_isolation ON derivatives
  FOR ALL USING (
    object_id IN (
      SELECT o.id FROM objects o
      JOIN buckets b ON o.bucket_id = b.id
      WHERE b.org_id = auth_org_id()
    )
  );

ALTER TABLE search_index ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON search_index;
CREATE POLICY org_isolation ON search_index
  FOR ALL USING (
    object_id IN (
      SELECT o.id FROM objects o
      JOIN buckets b ON o.bucket_id = b.id
      WHERE b.org_id = auth_org_id()
    )
  );

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON usage_events;
CREATE POLICY org_isolation ON usage_events
  FOR ALL USING (org_id = auth_org_id());

ALTER TABLE usage_rollups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON usage_rollups;
CREATE POLICY org_isolation ON usage_rollups
  FOR ALL USING (org_id = auth_org_id());

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON audit_log;
CREATE POLICY org_isolation ON audit_log
  FOR ALL USING (org_id = auth_org_id());

-- ========== Grants ==========

-- medialocker_service grants apply only when that role exists (self-hosted/CI).
-- On Supabase Cloud the role isn't created (insufficient privilege above) and the
-- app connects as the schema owner, so these are unnecessary there. Guarding them
-- keeps this migration runnable as the Cloud `postgres` role.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medialocker_service') THEN
    GRANT USAGE ON SCHEMA public TO medialocker_service;
    GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO medialocker_service;
    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO medialocker_service;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT ALL PRIVILEGES ON TABLES TO medialocker_service;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO anon;

-- Grant table privileges to Supabase client roles so RLS policies are reachable
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, anon;

-- Grant execute on the RLS helper function
GRANT EXECUTE ON FUNCTION auth_org_id() TO authenticated, anon;

-- ========== CHECK constraints (§F2) ==========

ALTER TABLE plans ADD CONSTRAINT plans_per_gb_price_cents_nonnegative CHECK (per_gb_price_cents >= 0);
ALTER TABLE billing_addons ADD CONSTRAINT billing_addons_cost_cents_nonnegative CHECK (cost_cents >= 0);
ALTER TABLE billing_addons ADD CONSTRAINT billing_addons_gb_nonnegative CHECK (gb >= 0);
ALTER TABLE objects ADD CONSTRAINT objects_size_nonnegative CHECK (size >= 0);
ALTER TABLE derivatives ADD CONSTRAINT derivatives_bytes_nonnegative CHECK (bytes >= 0);
ALTER TABLE multipart_uploads ADD CONSTRAINT multipart_uploads_total_bytes_nonnegative CHECK (total_bytes_reserved >= 0);
ALTER TABLE multipart_parts ADD CONSTRAINT multipart_parts_size_nonnegative CHECK (size >= 0);
ALTER TABLE usage_rollups ADD CONSTRAINT usage_rollups_stored_bytes_max_nonnegative CHECK (stored_bytes_max >= 0);
ALTER TABLE usage_rollups ADD CONSTRAINT usage_rollups_egress_bytes_nonnegative CHECK (egress_bytes >= 0);
ALTER TABLE usage_rollups ADD CONSTRAINT usage_rollups_request_count_nonnegative CHECK (request_count >= 0);

-- ========== updated_at trigger (§F6) ==========

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$ DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'updated_at'
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_set_updated_at ON %I;
       CREATE TRIGGER trg_set_updated_at
         BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      tbl, tbl
    );
  END LOOP;
END $$;

