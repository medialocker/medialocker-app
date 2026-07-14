import postgres from "postgres";
import { getConfig } from "@medialocker/config";

// base_price_cents is the published monthly subscription price (the single
// source of truth for the base Stripe price — see migration 011). per_gb_price_cents
// is the separate per-GB overage rate.
const PLANS = [
  {
    tier_key: "starter",
    name: "Starter",
    included_gb: 100,
    base_price_cents: 900,
    per_gb_price_cents: 4,
    stripe_price_id: null,
  },
  {
    tier_key: "pro",
    name: "Pro",
    included_gb: 1000,
    base_price_cents: 2900,
    per_gb_price_cents: 3,
    stripe_price_id: null,
  },
  {
    tier_key: "studio",
    name: "Studio",
    included_gb: 5000,
    base_price_cents: 9900,
    per_gb_price_cents: 2,
    stripe_price_id: null,
  },
];

async function seed(): Promise<void> {
  const sql = postgres(getConfig().DATABASE_URL, {
    max: 1,
    idle_timeout: 5_000,
    connect_timeout: 10_000,
  });

  try {
    for (const plan of PLANS) {
      const existing = await sql<
        { id: string }[]
      >`SELECT id FROM plans WHERE tier_key = ${plan.tier_key} LIMIT 1`;

      if (existing.length > 0) {
        console.log(`Plan ${plan.tier_key} already exists, skipping`);
        continue;
      }

      await sql`
        INSERT INTO plans (tier_key, name, included_gb, base_price_cents, per_gb_price_cents, stripe_price_id)
        VALUES (${plan.tier_key}, ${plan.name}, ${plan.included_gb}, ${plan.base_price_cents}, ${plan.per_gb_price_cents}, ${plan.stripe_price_id})
      `;
      console.log(`  ✓ inserted plan: ${plan.tier_key}`);
    }

    console.log("Seed complete.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
