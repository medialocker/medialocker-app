import type { Sql } from 'postgres';
import { getStripe } from './stripe.js';
import { gbToBytes, calculateAddOnCost, calculateProratedCost, acquireOrgLock } from '@medialocker/core';
import { notifyCapacityAdded } from './notify.js';

export interface AddOnResult {
  success: boolean;
  stripeItemId?: string;
  cost?: number;
  reason?: string;
}

function bigintParam(v: bigint): string {
  return String(v);
}

export async function addCapacity(
  client: Sql,
  orgId: string,
  gb: number,
  prorated: boolean,
): Promise<AddOnResult> {
  if (gb <= 0) {
    return { success: false, reason: 'GB must be positive' };
  }

  const stripe = getStripe();

  const result = await client.begin(async (tx) => {
    // Serialize concurrent capacity changes for this org so two simultaneous
    // adds (e.g. two over-quota writes both triggering auto-capacity) can't
    // double-add or both pass the max-spend check (§24).
    await acquireOrgLock(tx, orgId);

    const rows = await tx<
      {
        stripe_subscription_id: string;
        per_gb_price_cents: number;
        allocated_bytes: bigint;
        used_bytes: bigint;
        max_monthly_spend_cents: number;
        spend_this_cycle_cents: number;
        addon_stripe_price_id: string | null;
        current_period_end: string;
      }[]
    >`
      SELECT s.stripe_subscription_id,
             p.per_gb_price_cents,
             c.allocated_bytes,
             c.used_bytes,
             c.max_monthly_spend_cents,
             c.spend_this_cycle_cents,
             p.stripe_addon_price_id AS addon_stripe_price_id,
             s.current_period_end
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
        JOIN capacity c ON c.org_id = s.org_id
       WHERE s.org_id = ${orgId}
         AND s.status IN ('active', 'trialing')
       ORDER BY s.id DESC
       LIMIT 1
    `;

    const sub = rows[0];
    if (!sub) {
      return { success: false, reason: 'No active subscription found' } satisfies AddOnResult;
    }

    if (!sub.addon_stripe_price_id) {
      return {
        success: false,
        reason: 'No Stripe add-on price configured for this plan. Run setup:stripe.',
      } satisfies AddOnResult;
    }

    // P2.18 — Real proration from the ACTUAL subscription billing period, not a
    // hardcoded 30-day cycle. Our `subscriptions` table only stores
    // current_period_end, so the authoritative period START comes from Stripe.
    // Retrieve the live subscription and derive both the true cycle length and
    // the days remaining from its current_period_start/current_period_end. Fall
    // back to a 30-day cycle only if Stripe is unreachable or returns bogus
    // bounds, so a transient Stripe blip never crashes the add.
    let cost: number;
    if (prorated) {
      const CYCLE_DAYS_FALLBACK = 30;
      let daysInCycle = CYCLE_DAYS_FALLBACK;
      let periodEndMs = new Date(sub.current_period_end).getTime();
      try {
        const liveSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
        const startSec = liveSub.current_period_start;
        const endSec = liveSub.current_period_end;
        if (
          typeof startSec === 'number' &&
          typeof endSec === 'number' &&
          endSec > startSec
        ) {
          periodEndMs = endSec * 1000;
          daysInCycle = Math.max(1, Math.round((endSec - startSec) / 86_400));
        }
      } catch {
        // Stripe unreachable — fall back to current_period_end + 30-day cycle.
      }
      const msRemaining = periodEndMs - Date.now();
      const daysRemaining = Math.max(
        0,
        Math.min(daysInCycle, Math.ceil(msRemaining / 86_400_000)),
      );
      // calculateProratedCost signature is (gb, perGbPriceCents, daysInCycle,
      // daysRemaining). A prior version had these two swapped, which inverted
      // proration and over-charged as the cycle progressed. (§9.2)
      cost = calculateProratedCost(gb, sub.per_gb_price_cents, daysInCycle, daysRemaining);
    } else {
      cost = calculateAddOnCost(gb, sub.per_gb_price_cents);
    }

    // The cap is the "max monthly AUTOMATED spend" — it bounds add-on spend only
    // (spend_this_cycle_cents tracks add-on charges, not the base plan price), so
    // we intentionally do not subtract the base subscription cost here. (§9.8)
    if (
      sub.max_monthly_spend_cents > 0 &&
      sub.spend_this_cycle_cents + cost > sub.max_monthly_spend_cents
    ) {
      return {
        success: false,
        reason: `Adding ${gb} GB would exceed the max monthly spend of ${sub.max_monthly_spend_cents} cents`,
      } satisfies AddOnResult;
    }

    let stripeItemId: string;

    try {
      const existingItems = await stripe.subscriptionItems.list({
        subscription: sub.stripe_subscription_id,
        limit: 100,
      });

      const addonItem = existingItems.data.find(
        (item) => item.price.id === sub.addon_stripe_price_id,
      );

      if (addonItem) {
        const updated = await stripe.subscriptionItems.update(addonItem.id, {
          quantity: (addonItem.quantity ?? 0) + gb,
          proration_behavior: prorated ? 'create_prorations' : 'none',
        });
        stripeItemId = updated.id;
      } else {
        const item = await stripe.subscriptionItems.create({
          subscription: sub.stripe_subscription_id,
          price: sub.addon_stripe_price_id,
          quantity: gb,
          proration_behavior: prorated ? 'create_prorations' : 'none',
        });
        stripeItemId = item.id;
      }
    } catch (err) {
      return {
        success: false,
        reason: `Stripe error: ${err instanceof Error ? err.message : String(err)}`,
      } satisfies AddOnResult;
    }

    const gbBytes = gbToBytes(gb);

    await tx`
      UPDATE capacity
         SET allocated_bytes = allocated_bytes + ${bigintParam(gbBytes)}::bigint,
             spend_this_cycle_cents = spend_this_cycle_cents + ${cost}
       WHERE org_id = ${orgId}
    `;

    await tx`
      INSERT INTO billing_addons (org_id, stripe_item_id, gb, cost_cents, prorated, created_at)
      VALUES (${orgId}, ${stripeItemId}, ${gb}, ${cost}, ${prorated}, NOW())
    `;

    return { success: true, stripeItemId, cost } satisfies AddOnResult;
  });

  return result;
}

/**
 * Auto-capacity (§8): when an org goes over quota during a write, attempt to add
 * `increment_gb` of capacity — but go through the REAL billing path so a Stripe
 * add-on item is created/incremented and a `billing_addons` row is recorded
 * (capacity must never be granted without billing, §8/§26). Gated by
 * `auto_enabled`, the usage threshold, and `max_monthly_spend_cents` (the
 * max-spend cap is enforced inside `addCapacity`). Advisory-locked per org so
 * two concurrent over-quota writes don't double-add (§24).
 *
 * Threshold semantics match the rest of the engine: trigger when
 * `used_bytes / allocated_bytes >= threshold_pct/100`.
 */
export async function autoAddCapacity(
  client: Sql,
  orgId: string,
): Promise<{ added: boolean; addedGb?: number; cost?: number; reason?: string }> {
  const rows = await client<
    {
      auto_enabled: boolean;
      used_bytes: bigint;
      allocated_bytes: bigint;
      threshold_pct: number;
      increment_gb: number;
      max_monthly_spend_cents: number;
    }[]
  >`
    SELECT c.auto_enabled,
           c.used_bytes,
           c.allocated_bytes,
           c.threshold_pct,
           c.increment_gb,
           c.max_monthly_spend_cents
      FROM capacity c
     WHERE c.org_id = ${orgId}
  `;

  const cap = rows[0];
  if (!cap) return { added: false, reason: 'No capacity record' };
  if (!cap.auto_enabled) return { added: false, reason: 'Auto-capacity disabled' };
  // Defense-in-depth (C9): treat a NULL or 0 spend cap as disabled (NULL bypassed
  // the old `=== 0` check → unbounded automated spend), and a NULL/≤0 threshold as
  // not-configured (NULL coerced to 0 → an add on every over-quota write).
  if (!cap.max_monthly_spend_cents) {
    return { added: false, reason: 'Auto-capacity disabled (no max monthly spend)' };
  }
  if (cap.increment_gb <= 0) return { added: false, reason: 'increment_gb not configured' };
  if (cap.threshold_pct == null || cap.threshold_pct <= 0) {
    return { added: false, reason: 'threshold_pct not configured' };
  }

  const usageFraction =
    cap.allocated_bytes > BigInt(0)
      ? Number(cap.used_bytes) / Number(cap.allocated_bytes)
      : 1;
  if (usageFraction < cap.threshold_pct / 100) {
    return { added: false, reason: 'Below auto-capacity threshold' };
  }

  // Debounce (§8): a single atomic conditional UPDATE both checks and sets the
  // cooldown, so concurrent over-quota writes can't each trigger an add. Only the
  // first caller in the window gets a row back; the rest are throttled. (A failed
  // add still consumes the window, which is the desired anti-thrash behavior.)
  const COOLDOWN_SECONDS = 60;
  const claim = await client`
    UPDATE capacity SET last_auto_add_at = now()
     WHERE org_id = ${orgId}
       AND (last_auto_add_at IS NULL
            OR last_auto_add_at < now() - make_interval(secs => ${COOLDOWN_SECONDS}))
    RETURNING org_id
  `;
  if (claim.length === 0) {
    return { added: false, reason: 'Auto-capacity cooldown active' };
  }

  // Perform the add through the billed path: `addCapacity` creates/increments
  // the Stripe add-on item, records `billing_addons`, updates capacity, and
  // enforces the max-spend cap — all under its own per-org advisory lock (§24).
  const res = await addCapacity(client, orgId, cap.increment_gb, true);
  if (!res.success) return { added: false, reason: res.reason };

  // Best-effort "we added storage" email for the automatic top-up. Sent here (not
  // in confirmAddOn, which also fires for manual adds) so each add emails once.
  await notifyCapacityAdded(client, {
    orgId,
    addedGb: cap.increment_gb,
    costCents: res.cost ?? 0,
    auto: true,
  });

  return { added: true, addedGb: cap.increment_gb, cost: res.cost };
}

export async function removeCapacity(
  client: Sql,
  orgId: string,
  addonId: string,
): Promise<AddOnResult> {
  const stripe = getStripe();

  const result = await client.begin(async (tx) => {
    const addonRows = await tx<
      { stripe_item_id: string; gb: number; cost_cents: number; prorated: boolean }[]
    >`
      SELECT stripe_item_id, gb, cost_cents, prorated
        FROM billing_addons
       WHERE id = ${addonId}
         AND org_id = ${orgId}
    `;

    const addon = addonRows[0];
    if (!addon) {
      return { success: false, reason: 'Add-on not found' } satisfies AddOnResult;
    }

    const capRows = await tx<{ allocated_bytes: bigint; used_bytes: bigint }[]>`
      SELECT allocated_bytes, used_bytes
        FROM capacity
       WHERE org_id = ${orgId}
    `;

    const cap = capRows[0];
    if (!cap) {
      return { success: false, reason: 'Capacity record not found' } satisfies AddOnResult;
    }

    const gbBytes = gbToBytes(addon.gb);
    const proposedAllocated = cap.allocated_bytes - gbBytes;

    if (proposedAllocated < cap.used_bytes) {
      return {
        success: false,
        reason: `Cannot remove ${addon.gb} GB: used storage (${cap.used_bytes}) would exceed allocated (${proposedAllocated})`,
      } satisfies AddOnResult;
    }

    try {
      // Add-ons share ONE Stripe subscription item (addCapacity increments its
      // quantity), so removing this add-on must DECREMENT the shared item's
      // quantity by this add-on's GB — not zero it, which would drop every other
      // add-on too. When the decrement reaches zero we delete the item. (§9.5)
      const item = await stripe.subscriptionItems.retrieve(addon.stripe_item_id);
      const currentQty = item.quantity ?? 0;
      // Delete the SHARED item only when this add-on's gb exactly accounts for the
      // item's whole quantity (i.e. it is the last add-on). If Stripe's quantity
      // has drifted BELOW this add-on's gb, `currentQty - addon.gb` would floor to
      // 0 and deleting the item would silently drop every sibling add-on that
      // shares it. In that case decrement to a 0-floor and let the reconcile job
      // (§9.10 / C1) heal the divergence rather than destroying sibling state. (§9.5/2.4)
      if (currentQty === addon.gb) {
        const siblingRows = await tx<{ id: string }[]>`
          SELECT id FROM billing_addons
           WHERE stripe_item_id = ${addon.stripe_item_id}
             AND id != ${addonId}
             AND org_id = ${orgId}
           LIMIT 1
        `;
        if (siblingRows.length === 0) {
          await stripe.subscriptionItems.del(addon.stripe_item_id, { proration_behavior: 'none' });
        } else {
          await stripe.subscriptionItems.update(addon.stripe_item_id, {
            quantity: Math.max(0, currentQty - addon.gb),
            proration_behavior: 'none',
          });
        }
      } else {
        await stripe.subscriptionItems.update(addon.stripe_item_id, {
          quantity: Math.max(0, currentQty - addon.gb),
          proration_behavior: 'none',
        });
      }
    } catch (err) {
      return {
        success: false,
        reason: `Stripe error: ${err instanceof Error ? err.message : String(err)}`,
      } satisfies AddOnResult;
    }

    // P2.18: reconcile spend_this_cycle_cents against actual remaining add-on
    // ledger state by RECOMPUTING it from SUM(cost_cents) over the add-ons that
    // survive this removal (every billing_addons row except the one being
    // deleted). A delta-based decrement would drift from Stripe reality after
    // partial removals/refunds; re-deriving from the ledger keeps the DB spend in
    // lockstep with the Stripe subscription item quantity adjusted above.
    await tx`
      UPDATE capacity
         SET allocated_bytes = allocated_bytes - ${bigintParam(gbBytes)}::bigint,
             spend_this_cycle_cents = COALESCE((
               SELECT SUM(cost_cents)
                 FROM billing_addons
                WHERE org_id = ${orgId}
                  AND id != ${addonId}
             ), 0)
       WHERE org_id = ${orgId}
    `;

    await tx`
      DELETE FROM billing_addons
       WHERE id = ${addonId}
    `;

    return { success: true } satisfies AddOnResult;
  });

  return result;
}

export async function confirmAddOn(
  client: Sql,
  stripeItemId: string,
  _quantity: number,
): Promise<void> {
  // Reconcile the org's allocated capacity to the ABSOLUTE truth from the ledger:
  // plan included GB + SUM of all add-on GB. This is idempotent — safe no matter
  // how many times the Stripe webhook re-fires — and crucially does NOT
  // double-count with addCapacity (which already adjusted allocated_bytes
  // synchronously). A previous delta-based version over-allocated for orgs with
  // ≥2 add-ons, because all add-ons share ONE Stripe item so `stripe_item_id` is
  // not unique and the Stripe `quantity` is the SUM, not any single row's gb.
  // (§9.9)
  await client.begin(async (tx) => {
    const rows = await tx<{ org_id: string }[]>`
      SELECT org_id FROM billing_addons WHERE stripe_item_id = ${stripeItemId} LIMIT 1
    `;
    const orgId = rows[0]?.org_id;
    if (!orgId) return;

    const planRows = await tx<{ included_gb: string }[]>`
      SELECT p.included_gb
        FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.org_id = ${orgId}
       ORDER BY s.created_at DESC
       LIMIT 1
    `;
    if (planRows.length === 0) return;

    const addonRows = await tx<{ total: string }[]>`
      SELECT COALESCE(SUM(gb), 0)::text AS total FROM billing_addons WHERE org_id = ${orgId}
    `;

    const includedGb = Number(planRows[0]!.included_gb);
    const addonGb = Number(addonRows[0]!.total);
    const allocated = gbToBytes(includedGb) + gbToBytes(addonGb);

    // C4: reconcile spend_this_cycle_cents too — the webhook confirms the
    // Stripe invoice item is real, so re-derive the cycle spend from the ledger
    // (SUM of cost_cents for all billing_addons rows). The old code left
    // spend_this_cycle_cents stale after partial refunds/removals, creating a
    // permanent drift between DB spend and Stripe reality.
    await tx`
      UPDATE capacity
         SET allocated_bytes = ${allocated.toString()}::bigint,
             spend_this_cycle_cents = COALESCE(
               (SELECT SUM(cost_cents) FROM billing_addons WHERE org_id = ${orgId}), 0
             )
       WHERE org_id = ${orgId}
    `;
  });
}
