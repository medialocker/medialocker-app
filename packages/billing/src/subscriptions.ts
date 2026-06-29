import type { Sql } from 'postgres';
import Stripe from 'stripe';
import { getStripe } from './stripe.js';
import { getPlanById } from './plans.js';

export interface SubscriptionRow {
  id: string;
  org_id: string;
  stripe_subscription_id: string;
  plan_id: string;
  status: string;
  current_period_end: Date;
}

function bigintParam(v: bigint): string {
  return String(v);
}

export async function createSubscription(
  client: Sql,
  orgId: string,
  planId: string,
  stripeCustomerId: string,
): Promise<{ subscriptionId: string; stripeSubscriptionId: string }> {
  const stripe = getStripe();
  const plan = await getPlanById(client, planId);

  if (!plan) {
    throw new Error(`Plan not found: ${planId}`);
  }

  if (!plan.stripe_price_id) {
    throw new Error(`Plan ${plan.tier_key} has no Stripe price. Run setup:stripe first.`);
  }

  let sub: Stripe.Subscription;
  try {
    sub = await stripe.subscriptions.create({
      customer: stripeCustomerId,
      items: [{ price: plan.stripe_price_id }],
      payment_behavior: 'default_incomplete',
      metadata: { org_id: orgId, plan_id: planId },
      expand: ['latest_invoice.payment_intent'],
    });
  } catch (err) {
    throw new Error(
      `Failed to create Stripe subscription: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const periodEnd = new Date(sub.current_period_end * 1000);

  const inserted = await client<{ id: string }[]>`
    INSERT INTO subscriptions (org_id, plan_id, stripe_subscription_id, status, current_period_end)
    VALUES (${orgId}, ${planId}, ${sub.id}, ${sub.status}, ${periodEnd.toISOString()})
    RETURNING id
  `;

  const subscriptionId = inserted[0]?.id;
  if (!subscriptionId) {
    throw new Error('Failed to insert subscription record');
  }

  const allocatedBytes = BigInt(plan.included_gb) * BigInt(1_000_000_000);

  const capacityRows = await client<{ org_id: string }[]>`
    SELECT org_id FROM capacity WHERE org_id = ${orgId}
  `;

  if (capacityRows.length === 0) {
    await client`
      INSERT INTO capacity (org_id, allocated_bytes, used_bytes, auto_enabled,
                            increment_gb, threshold_pct, max_monthly_spend_cents,
                            spend_this_cycle_cents)
      VALUES (${orgId}, ${bigintParam(allocatedBytes)}::bigint, 0, false, 10, 80, 0, 0)
    `;
  } else {
    await client`
      UPDATE capacity
         SET allocated_bytes = ${bigintParam(allocatedBytes)}::bigint,
             spend_this_cycle_cents = 0
       WHERE org_id = ${orgId}
    `;
  }

  return {
    subscriptionId,
    stripeSubscriptionId: sub.id,
  };
}

export async function cancelSubscription(
  client: Sql,
  orgId: string,
): Promise<{ canceled: boolean; stripeSubscriptionId: string }> {
  const stripe = getStripe();

  // Select the LATEST subscription deterministically — an org can accumulate
  // historical rows (e.g. after a plan re-checkout), and an unordered LIMIT-less
  // read could cancel the wrong one.
  const subs = await client<
    { stripe_subscription_id: string; status: string }[]
  >`
    SELECT stripe_subscription_id, status
      FROM subscriptions
     WHERE org_id = ${orgId}
     ORDER BY id DESC
     LIMIT 1
  `;

  const sub = subs[0];
  if (!sub) {
    throw new Error('No subscription found for this organization');
  }

  if (sub.status === 'canceled') {
    return { canceled: true, stripeSubscriptionId: sub.stripe_subscription_id };
  }

  // P2.17: cancel with explicit, payment-free semantics. The previous flow only
  // set `cancel_at_period_end` while the subscription had been CREATED with
  // `payment_behavior: 'default_incomplete'` — so an org that never confirmed the
  // initial payment was left stuck in Stripe's `incomplete` state, and a bare
  // schedule-at-period-end update could emit a proration invoice. Two cases:
  //
  //   * If the subscription was never activated (incomplete / incomplete_expired
  //     / a status that has no paid period to honour), cancel it IMMEDIATELY with
  //     no proration and no invoice — there is nothing to bill and nothing to
  //     keep running until period end.
  //   * Otherwise (active/trialing/past_due), schedule cancellation at period end
  //     and explicitly disable proration so no extra incomplete invoice is created.
  const unconfirmed =
    sub.status === 'incomplete' ||
    sub.status === 'incomplete_expired' ||
    sub.status === 'paused';

  if (unconfirmed) {
    await stripe.subscriptions.cancel(sub.stripe_subscription_id, {
      invoice_now: false,
      prorate: false,
    });
    await client`
      UPDATE subscriptions
         SET status = 'canceled'
       WHERE stripe_subscription_id = ${sub.stripe_subscription_id}
    `;
    return { canceled: true, stripeSubscriptionId: sub.stripe_subscription_id };
  }

  await stripe.subscriptions.update(sub.stripe_subscription_id, {
    cancel_at_period_end: true,
    proration_behavior: 'none',
  });

  await client`
    UPDATE subscriptions
       SET status = 'canceling'
     WHERE stripe_subscription_id = ${sub.stripe_subscription_id}
  `;

  return { canceled: true, stripeSubscriptionId: sub.stripe_subscription_id };
}

export async function getSubscription(
  client: Sql,
  orgId: string,
): Promise<SubscriptionRow | null> {
  const rows = await client<SubscriptionRow[]>`
    SELECT id, org_id, stripe_subscription_id, plan_id, status, current_period_end
      FROM subscriptions
     WHERE org_id = ${orgId}
     ORDER BY id DESC
     LIMIT 1
  `;

  return rows[0] ?? null;
}

export async function syncSubscriptionStatus(
  client: Sql,
  stripeSub: Stripe.Subscription,
): Promise<void> {
  const periodEnd = new Date(stripeSub.current_period_end * 1000);
  const orgId = stripeSub.metadata?.org_id;
  if (!orgId) return;

  const status = stripeSub.status;

  await client`
    UPDATE subscriptions
       SET status = ${status},
           current_period_end = ${periodEnd.toISOString()}
     WHERE stripe_subscription_id = ${stripeSub.id}
  `;

  if (status === 'canceled' || status === 'unpaid') {
    // Stop auto-capacity for a non-paying org — otherwise auto-add would keep
    // provisioning (and attempting to bill) capacity on a canceled/unpaid sub. (C12)
    await client`UPDATE capacity SET auto_enabled = false WHERE org_id = ${orgId}`;
    const planId = stripeSub.metadata?.plan_id;
    if (planId) {
      const plans = await client<{ included_gb: number }[]>`
        SELECT included_gb FROM plans WHERE id = ${planId}
      `;
      const planRow = plans[0];
      const addonRows = await client<{ total_gb: number }[]>`
        SELECT COALESCE(SUM(gb), 0) AS total_gb FROM billing_addons WHERE org_id = ${orgId}
      `;
      const totalGb = (planRow ? planRow.included_gb : 0) + (addonRows[0]?.total_gb ?? 0);
      const newAllocated = BigInt(totalGb) * BigInt(1_000_000_000);

      // C08: do NOT clamp allocated_bytes above the paid entitlement.
      // The old code set allocated = max(paid, used), granting free overage
      // to canceled orgs that had exceeded their plan. Now we set it to the
      // paid amount only — if used > allocated, writes are blocked until the
      // org deletes data or resubscribes.
      await client`
        UPDATE capacity SET allocated_bytes = ${bigintParam(newAllocated)}::bigint
         WHERE org_id = ${orgId}
      `;
    }
  }
}
