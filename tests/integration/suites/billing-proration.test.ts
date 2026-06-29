/**
 * §9.2 — mid-cycle add-on proration.
 *
 * A capacity add-on purchased partway through the billing cycle must bill the
 * PRORATED amount (full cost * daysRemaining / cycleDays), not the full monthly
 * cost. A prior version had the proration arguments swapped, inverting the ratio
 * (cost = full * cycle/remaining) and OVER-charging as the cycle progressed.
 *
 * This is an integration test of the REAL @medialocker/billing.addCapacity path
 * against REAL Postgres: it seeds a plan + active subscription with a known
 * current_period_end, runs addCapacity(prorated=true), and asserts the cost
 * written to billing_addons + spend_this_cycle_cents equals the prorated math
 * (and is strictly less than the full cost). Stripe's NETWORK calls are stubbed
 * (we are testing period math + DB writes, not Stripe's API), but every DB
 * mutation and the proration calculation run for real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Stub the Stripe client the billing module constructs, BEFORE importing the
// module under test. addCapacity only needs subscriptionItems.list/create to
// resolve; we return a deterministic item so the DB write path executes.
vi.mock("../../../packages/billing/src/stripe.js", () => {
  const fakeStripe = {
    subscriptionItems: {
      list: vi.fn(async () => ({ data: [] as Array<{ id: string; price: { id: string }; quantity?: number }> })),
      create: vi.fn(async () => ({ id: "si_itest_created" })),
      update: vi.fn(async () => ({ id: "si_itest_updated" })),
    },
  };
  return {
    getStripe: () => fakeStripe,
    getStripeClient: () => fakeStripe,
    STRIPE_API_VERSION: "2025-02-24.acacia",
  };
});

import type { Sql } from "postgres";
import { makeTestSql } from "../scripts/clients.js";
import { seedOrg, seedPlanAndSubscription, gb } from "../scripts/seed.js";
import { calculateProratedCost } from "@medialocker/core";
// Import addCapacity from source so the vi.mock of './stripe.js' applies.
import { addCapacity } from "../../../packages/billing/src/capacity-addons.js";

const CYCLE_DAYS = 30;

let sql: Sql;

beforeAll(() => {
  sql = makeTestSql();
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function readAddon(orgId: string) {
  const rows = await sql<
    { gb: number | string | bigint; cost_cents: number | string | bigint; prorated: boolean }[]
  >`SELECT gb, cost_cents, prorated FROM billing_addons WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`;
  const r = rows[0]!;
  // gb/cost_cents are small counts; the driver may hand them back as int8
  // (BigInt) or numeric (string) depending on column type — normalize to Number.
  return { gb: Number(r.gb), cost_cents: Number(r.cost_cents), prorated: r.prorated };
}

async function readSpend(orgId: string) {
  const rows = await sql<{ spend_this_cycle_cents: number | string | bigint }[]>`
    SELECT spend_this_cycle_cents FROM capacity WHERE org_id = ${orgId}
  `;
  return Number(rows[0]!.spend_this_cycle_cents);
}

describe("§9.2 mid-cycle add-on bills the prorated amount", () => {
  it("with 15 of 30 days remaining, charges ~half of the full cost", async () => {
    const perGbPriceCents = 2;
    const addGb = 100;
    const daysRemaining = 15;

    const org = await seedOrg(sql, { allocatedBytes: gb(100), usedBytes: 0n });
    await seedPlanAndSubscription(sql, org.orgId, {
      includedGb: 100,
      perGbPriceCents,
      daysRemaining,
    });

    const res = await addCapacity(sql, org.orgId, addGb, true);
    expect(res.success).toBe(true);

    // addCapacity computes daysRemaining via Math.ceil(msRemaining/86_400_000),
    // which for a period_end exactly `daysRemaining` days out lands on
    // daysRemaining (allow +/-1 for the sub-second clock skew at insert time).
    const fullCost = addGb * perGbPriceCents; // 200 cents
    const expectedAt15 = calculateProratedCost(
      addGb,
      perGbPriceCents,
      CYCLE_DAYS,
      15,
    );
    const expectedAt14 = calculateProratedCost(addGb, perGbPriceCents, CYCLE_DAYS, 14);
    const expectedAt16 = calculateProratedCost(addGb, perGbPriceCents, CYCLE_DAYS, 16);

    const addon = await readAddon(org.orgId);
    expect(addon.prorated).toBe(true);
    expect(addon.gb).toBe(addGb);

    // The recorded cost is the PRORATED value (~100 cents), within rounding of
    // the 14/15/16-day window, and STRICTLY LESS than the full 200 cents.
    expect([expectedAt14, expectedAt15, expectedAt16]).toContain(addon.cost_cents);
    expect(addon.cost_cents).toBeLessThan(fullCost);
    expect(addon.cost_cents).toBeGreaterThan(0);
    // The known-good midpoint value for 15/30 days is exactly half.
    expect(expectedAt15).toBe(fullCost / 2);

    // spend_this_cycle_cents was incremented by the same prorated cost.
    expect(await readSpend(org.orgId)).toBe(addon.cost_cents);

    // allocated_bytes grew by the added GB.
    const cap = await sql<{ allocated_bytes: bigint }[]>`
      SELECT allocated_bytes FROM capacity WHERE org_id = ${org.orgId}
    `;
    expect(cap[0]!.allocated_bytes).toBe(gb(100) + gb(addGb));
  });

  it("non-prorated add-on bills the FULL cost (control)", async () => {
    const perGbPriceCents = 2;
    const addGb = 100;

    const org = await seedOrg(sql, { allocatedBytes: gb(100), usedBytes: 0n });
    await seedPlanAndSubscription(sql, org.orgId, {
      includedGb: 100,
      perGbPriceCents,
      daysRemaining: 15,
    });

    const res = await addCapacity(sql, org.orgId, addGb, false);
    expect(res.success).toBe(true);

    const addon = await readAddon(org.orgId);
    expect(addon.prorated).toBe(false);
    // Full cost, NOT prorated — proves the prorated branch is what reduces it.
    expect(addon.cost_cents).toBe(addGb * perGbPriceCents);
  });
});
