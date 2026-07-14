import type { Sql } from 'postgres';
import { getStripe } from './stripe.js';
import { gbToBytes, acquireOrgLock } from '@medialocker/core';

/**
 * Result of a plan change (upgrade or downgrade). Discriminated by `success`;
 * on failure `code` lets the caller map to the right HTTP status while keeping
 * Stripe specifics out of the route layer.
 */
export interface ChangePlanResult {
  success: boolean;
  planName?: string;
  /** Name of the plan the org was on before this change (for the email). */
  previousPlanName?: string;
  newAllocatedBytes?: bigint;
  code?: 'DowngradeBlocked' | 'NotFound' | 'NoSubscription' | 'NotConfigured' | 'StripeError';
  reason?: string;
  /** When code === 'DowngradeBlocked': GB the org must free before the change fits. */
  freeGb?: number;
}

/**
 * Change an org's subscription to a different plan tier, syncing Stripe.
 *
 * This is the billed counterpart to the control-plane's DB-only fallback: it
 * swaps the subscription's **base** price item (the plan price — never an
 * add-on item) to the target plan's `stripe_price_id` with proration, then
 * re-points `subscriptions.plan_id` and resizes `capacity.allocated_bytes` to
 * the new plan's included GB + active add-on GB.
 *
 * The §8 shrink guard is enforced first: a downgrade can never drop allocated
 * capacity below `used_bytes`. Advisory-locked per org so a concurrent
 * capacity-add and a plan change can't race on `allocated_bytes` (§24).
 *
 * Allocated capacity is the source of truth for what an org can store; the
 * Stripe swap and the DB updates happen in one transaction so they can't drift.
 */
export async function changePlan(
  client: Sql,
  orgId: string,
  tierKey: string,
): Promise<ChangePlanResult> {
  const stripe = getStripe();

  return client.begin(async (tx) => {
    await acquireOrgLock(tx, orgId);

    const planRows = await tx<
      { id: string; name: string; included_gb: string; stripe_price_id: string | null }[]
    >`
      SELECT id, name, included_gb, stripe_price_id
        FROM plans WHERE tier_key = ${tierKey} LIMIT 1
    `;
    const plan = planRows[0];
    if (!plan) {
      return { success: false, code: 'NotFound', reason: 'Unknown plan tier' };
    }
    if (!plan.stripe_price_id) {
      return {
        success: false,
        code: 'NotConfigured',
        reason: 'Target plan has no Stripe price configured. Run setup:stripe.',
      };
    }

    const subRows = await tx<
      {
        stripe_subscription_id: string | null;
        current_price_id: string | null;
        current_plan_name: string;
      }[]
    >`
      SELECT s.stripe_subscription_id,
             p.stripe_price_id AS current_price_id,
             p.name AS current_plan_name
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
       WHERE s.org_id = ${orgId}
         AND s.status IN ('active', 'trialing')
       ORDER BY s.id DESC
       LIMIT 1
    `;
    const sub = subRows[0];
    if (!sub || !sub.stripe_subscription_id) {
      return { success: false, code: 'NoSubscription', reason: 'No active subscription found' };
    }

    const capRows = await tx<{ used_bytes: string }[]>`
      SELECT used_bytes FROM capacity WHERE org_id = ${orgId}
    `;
    if (capRows.length === 0) {
      return { success: false, code: 'NotFound', reason: 'No capacity record found' };
    }

    const addonRows = await tx<{ total_gb: string }[]>`
      SELECT COALESCE(SUM(gb), 0)::text AS total_gb FROM billing_addons WHERE org_id = ${orgId}
    `;
    const targetAllocated =
      gbToBytes(Number(plan.included_gb)) + gbToBytes(Number(addonRows[0]!.total_gb));
    const used = BigInt(capRows[0]!.used_bytes);

    // Shrink guard (§8): never let allocated drop below what is actually stored.
    if (targetAllocated < used) {
      const freeGb = Math.ceil(Number(used - targetAllocated) / 1e9);
      return {
        success: false,
        code: 'DowngradeBlocked',
        reason: `This plan holds less than your current usage. Free ${freeGb} GB before downgrading.`,
        freeGb,
      };
    }

    // Swap the base plan price item in Stripe (leave add-on items untouched).
    try {
      const items = await stripe.subscriptionItems.list({
        subscription: sub.stripe_subscription_id,
        limit: 100,
      });
      // Swap ONLY the base plan price item — the one whose price.id matches the
      // current plan's stripe_price_id. Never fall back to items.data[0]: with
      // add-ons present that could be a capacity add-on item, which we'd wrongly
      // convert into the plan price. Error out instead. (§9.6)
      const baseItem = items.data.find((it) => it.price.id === sub.current_price_id);
      if (!baseItem) {
        return {
          success: false,
          code: 'StripeError',
          reason: 'Could not find the current plan price item on the subscription to swap.',
        };
      }
      await stripe.subscriptionItems.update(baseItem.id, {
        price: plan.stripe_price_id,
        proration_behavior: 'create_prorations',
      });
    } catch (err) {
      return {
        success: false,
        code: 'StripeError',
        reason: `Stripe error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    await tx`UPDATE subscriptions SET plan_id = ${plan.id} WHERE org_id = ${orgId}`;
    await tx`
      UPDATE capacity SET allocated_bytes = ${targetAllocated.toString()}::bigint
       WHERE org_id = ${orgId}
    `;

    return {
      success: true,
      planName: plan.name,
      previousPlanName: sub.current_plan_name,
      newAllocatedBytes: targetAllocated,
    };
  });
}
