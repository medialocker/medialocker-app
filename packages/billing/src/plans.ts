import type { Sql } from 'postgres';
import { getStripe } from './stripe.js';

export interface PlanRow {
  id: string;
  tier_key: string;
  name: string;
  included_gb: number;
  per_gb_price_cents: number;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  stripe_addon_price_id: string | null;
}

export async function getPlans(client: Sql): Promise<PlanRow[]> {
  return client<PlanRow[]>`
    SELECT id, tier_key, name, included_gb, per_gb_price_cents,
           stripe_product_id, stripe_price_id, stripe_addon_price_id
      FROM plans
     ORDER BY included_gb ASC
  `;
}

export async function getPlanById(
  client: Sql,
  planId: string,
): Promise<PlanRow | null> {
  const rows = await client<PlanRow[]>`
    SELECT id, tier_key, name, included_gb, per_gb_price_cents,
           stripe_product_id, stripe_price_id, stripe_addon_price_id
      FROM plans
     WHERE id = ${planId}
  `;
  return rows[0] ?? null;
}

export async function getPlanByTierKey(
  client: Sql,
  tierKey: string,
): Promise<PlanRow | null> {
  const rows = await client<PlanRow[]>`
    SELECT id, tier_key, name, included_gb, per_gb_price_cents,
           stripe_product_id, stripe_price_id, stripe_addon_price_id
      FROM plans
     WHERE tier_key = ${tierKey}
  `;
  return rows[0] ?? null;
}

export async function syncPlanToStripe(
  client: Sql,
  plan: PlanRow,
): Promise<PlanRow> {
  const stripe = getStripe();

  let productId = plan.stripe_product_id;
  let basePriceId = plan.stripe_price_id;
  let addonPriceId = plan.stripe_addon_price_id;

  if (!productId) {
    // tier_key is a controlled identifier, but escape any single quote/backslash
    // defensively so a stray character can't break (or inject into) the Stripe
    // search query string. (P2)
    const safeTierKey = plan.tier_key.replace(/[\\']/g, '\\$&');
    const existing = await stripe.products.search({
      query: `metadata['tier_key']:'${safeTierKey}'`,
      limit: 1,
    });
    if (existing.data.length > 0 && existing.data[0]) {
      productId = existing.data[0].id;
      await stripe.products.update(productId, {
        name: plan.name,
        metadata: { tier_key: plan.tier_key },
      });
    }
  }

  if (!productId) {
    const product = await stripe.products.create({
      name: plan.name,
      metadata: { tier_key: plan.tier_key },
    });
    productId = product.id;
  } else {
    await stripe.products.update(productId, {
      name: plan.name,
    });
  }

  const existingPrices = await stripe.prices.list({
    product: productId,
    active: true,
    limit: 5,
  });

  const basePriceCents = Math.round(plan.included_gb * plan.per_gb_price_cents);
  const existingBasePrice = existingPrices.data.find(
    (p) =>
      p.recurring?.interval === 'month' &&
      p.metadata?.type === 'base',
  );

  if (existingBasePrice && existingBasePrice.unit_amount === basePriceCents) {
    basePriceId = existingBasePrice.id;
  } else {
    if (existingBasePrice) {
      await stripe.prices.update(existingBasePrice.id, { active: false });
    }
    const basePrice = await stripe.prices.create({
      product: productId,
      currency: 'usd',
      unit_amount: basePriceCents,
      recurring: { interval: 'month' },
      metadata: { tier_key: plan.tier_key, type: 'base' },
    });
    basePriceId = basePrice.id;
  }

  const addonUnitAmount = plan.per_gb_price_cents;
  const existingAddonPrice = existingPrices.data.find(
    (p) =>
      p.recurring?.interval === 'month' &&
      p.metadata?.type === 'addon',
  );

  let addonUnitMatch = false;
  if (existingAddonPrice) {
    if (existingAddonPrice.unit_amount_decimal === String(addonUnitAmount)) {
      addonUnitMatch = true;
      addonPriceId = existingAddonPrice.id;
    } else {
      await stripe.prices.update(existingAddonPrice.id, { active: false });
    }
  }

  if (!addonUnitMatch) {
    const addonPrice = await stripe.prices.create({
      product: productId,
      currency: 'usd',
      unit_amount_decimal: String(addonUnitAmount),
      recurring: { interval: 'month' },
      metadata: { tier_key: plan.tier_key, type: 'addon' },
    });
    addonPriceId = addonPrice.id;
  }

  await client`
    UPDATE plans
       SET stripe_product_id = ${productId},
           stripe_price_id = ${basePriceId},
           stripe_addon_price_id = ${addonPriceId}
     WHERE id = ${plan.id}
  `;

  return {
    ...plan,
    stripe_product_id: productId,
    stripe_price_id: basePriceId,
    stripe_addon_price_id: addonPriceId,
  };
}
