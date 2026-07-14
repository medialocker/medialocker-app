-- 011_plans_base_price.sql
-- Make the DB the single source of truth for the recurring SUBSCRIPTION price.
--
-- Until now the base Stripe price was derived as included_gb * per_gb_price_cents
-- (packages/billing/src/plans.ts), which conflates the per-GB OVERAGE rate with
-- the monthly plan price and does NOT match the published tier prices
-- ($9 / $29 / $99). Add a first-class base_price_cents column: syncPlanToStripe
-- now uses it for the base recurring price, and GET /api/plans exposes it so the
-- marketing site reads the price from the DB instead of hardcoded env vars.
--
-- No BEGIN/COMMIT — the migration runner wraps each file in its own transaction
-- (packages/db/scripts/migrate.ts).

ALTER TABLE plans ADD COLUMN IF NOT EXISTS base_price_cents INTEGER;

-- Backfill existing rows. Known launch tiers get their published monthly price;
-- any custom tier falls back to the previous derived value so the NOT NULL set
-- below can never fail on unexpected data.
UPDATE plans SET base_price_cents = CASE tier_key
  WHEN 'starter' THEN 900
  WHEN 'pro'     THEN 2900
  WHEN 'studio'  THEN 9900
  ELSE ROUND(included_gb * per_gb_price_cents)::int
END
WHERE base_price_cents IS NULL;

ALTER TABLE plans ALTER COLUMN base_price_cents SET NOT NULL;
ALTER TABLE plans ADD CONSTRAINT plans_base_price_cents_nonnegative CHECK (base_price_cents >= 0);
