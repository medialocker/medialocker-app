import postgres from 'postgres';
import { loadConfig, getConfig, resetConfig } from '@medialocker/config';
import { getStripe } from '../src/stripe.js';
import { syncPlanToStripe, getPlans } from '../src/plans.js';

// base_price_cents = published monthly subscription price (source of truth for
// the base Stripe price). per_gb_price_cents = the separate per-GB overage rate,
// in WHOLE cents (the column is INTEGER). These are ~6x/5x/3x the ~0.6c/GB
// Hetzner marginal storage cost for Starter/Pro/Studio.
const DEFAULT_PLANS = [
  { tier_key: 'starter', name: 'Starter', included_gb: 100, base_price_cents: 900, per_gb_price_cents: 4 },
  { tier_key: 'pro', name: 'Pro', included_gb: 1000, base_price_cents: 2900, per_gb_price_cents: 3 },
  { tier_key: 'studio', name: 'Studio', included_gb: 5000, base_price_cents: 9900, per_gb_price_cents: 2 },
];

async function main() {
  loadConfig();

  const config = getConfig();

  if (!config.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY is not set. Check your .env file.');
    process.exit(1);
  }

  if (!config.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Check your .env file.');
    process.exit(1);
  }

  const stripe = getStripe();
  // One-shot setup script. `prepare: false` keeps it compatible with the Supabase
  // Cloud pooler; run it against the session pooler (5432) or a direct connection.
  const sql = postgres(config.DATABASE_URL, { prepare: false });

  console.log('Initializing Stripe products and prices...\n');

  try {
    for (const planDefaults of DEFAULT_PLANS) {
      console.log(`Processing tier: ${planDefaults.name} (${planDefaults.tier_key})`);

      const existingPlans = await sql<
        Array<{
          id: string;
          tier_key: string;
          name: string;
          included_gb: number;
          base_price_cents: number;
          per_gb_price_cents: number;
          stripe_product_id: string | null;
          stripe_price_id: string | null;
          stripe_addon_price_id: string | null;
        }>
      >`
        SELECT id, tier_key, name, included_gb, base_price_cents, per_gb_price_cents,
               stripe_product_id, stripe_price_id, stripe_addon_price_id
          FROM plans
         WHERE tier_key = ${planDefaults.tier_key}
      `;

      let planId: string;

      if (existingPlans.length === 0) {
        const inserted = await sql<[{ id: string }]>`
          INSERT INTO plans (tier_key, name, included_gb, base_price_cents, per_gb_price_cents)
          VALUES (${planDefaults.tier_key}, ${planDefaults.name},
                  ${planDefaults.included_gb}, ${planDefaults.base_price_cents},
                  ${planDefaults.per_gb_price_cents})
          RETURNING id
        `;
        planId = inserted[0]!.id;
        console.log(`  Created plan record: ${planId}`);
      } else {
        planId = existingPlans[0]!.id;
        await sql`
          UPDATE plans
             SET name = ${planDefaults.name},
                 included_gb = ${planDefaults.included_gb},
                 base_price_cents = ${planDefaults.base_price_cents},
                 per_gb_price_cents = ${planDefaults.per_gb_price_cents}
           WHERE id = ${planId}
        `;
        console.log(`  Updated existing plan: ${planId}`);
      }

      const planRow = {
        id: planId,
        tier_key: planDefaults.tier_key,
        name: planDefaults.name,
        included_gb: planDefaults.included_gb,
        base_price_cents: planDefaults.base_price_cents,
        per_gb_price_cents: planDefaults.per_gb_price_cents,
        stripe_product_id: existingPlans[0]?.stripe_product_id ?? null,
        stripe_price_id: existingPlans[0]?.stripe_price_id ?? null,
        stripe_addon_price_id: existingPlans[0]?.stripe_addon_price_id ?? null,
      };

      const synced = await syncPlanToStripe(sql, planRow);
      console.log(`  Stripe product: ${synced.stripe_product_id}`);
      console.log(`  Stripe base price: ${synced.stripe_price_id}`);
      console.log(`  Stripe addon price: ${synced.stripe_addon_price_id}`);
      console.log();
    }

    const allPlans = await getPlans(sql);
    console.log('All plans after sync:');
    for (const p of allPlans) {
      console.log(
        `  ${p.name.padEnd(10)} | ${String(p.included_gb).padEnd(6)} GB | ${String(p.per_gb_price_cents)} c/GB | product=${p.stripe_product_id} | price=${p.stripe_price_id} | addon_price=${p.stripe_addon_price_id}`,
      );
    }

    console.log('\nDone. Stripe setup complete.\n');
  } catch (err) {
    console.error('Setup failed:', err);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
