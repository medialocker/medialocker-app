import crypto from 'node:crypto';
import type { Sql } from 'postgres';
import Stripe from 'stripe';
import { S3Client, CreateBucketCommand, PutPublicAccessBlockCommand } from '@aws-sdk/client-s3';
import { getStripeClient } from './stripe.js';
import { getConfig } from '@medialocker/config';
import { encrypt } from '@medialocker/auth';
import { buildBucketName } from '@medialocker/core';
import { syncSubscriptionStatus } from './subscriptions.js';
import { confirmAddOn } from './capacity-addons.js';
import { createLogger } from '@medialocker/observability';

const log = createLogger('billing:webhook');

export interface WebhookContext {
  client: Sql;
  stripe?: Stripe;
}

export type WebhookEventHandler = (
  event: Stripe.Event,
  ctx: WebhookContext,
) => Promise<void>;

export async function handleWebhook(
  rawBody: string | Buffer,
  signature: string,
  ctx: WebhookContext,
): Promise<{ received: boolean; eventId?: string; error?: string }> {
  const config = getConfig();
  const stripe = ctx.stripe ?? getStripeClient();

  if (!config.STRIPE_WEBHOOK_SECRET) {
    return { received: false, error: 'STRIPE_WEBHOOK_SECRET is not configured' };
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'),
      signature,
      config.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    log.error({ err }, 'Webhook signature verification failed');
    return { received: false, error: 'Signature verification failed' };
  }

  const eventId = event.id;

  // Atomically claim the event. ON CONFLICT DO NOTHING RETURNING closes the
  // SELECT-then-INSERT race: only the delivery that actually inserts the row
  // (gets a RETURNING row) processes the event; a concurrent redelivery gets
  // zero rows and is skipped. This replaces the prior check-then-insert that
  // could let two simultaneous deliveries both pass the existence check.
  const claimed = await ctx.client`
    INSERT INTO webhook_events (event_id, event_type, processed_at)
    VALUES (${eventId}, ${event.type}, NOW())
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id
  `;

  if (claimed.length === 0) {
    log.info({ eventId, type: event.type }, 'Duplicate webhook event ignored');
    return { received: true, eventId };
  }

  try {
    await dispatchEvent(event, ctx);
  } catch (err) {
    log.error({ err, eventId, type: event.type }, 'Webhook handler failed');
    // Release the claim so Stripe's retry can reprocess this event. The claim is
    // now atomic, so this no longer reopens the race the SELECT-then-INSERT had.
    await ctx.client`
      DELETE FROM webhook_events WHERE event_id = ${eventId}
    `;
    throw err;
  }

  return { received: true, eventId };
}

async function dispatchEvent(
  event: Stripe.Event,
  ctx: WebhookContext,
): Promise<void> {
  log.info({ eventId: event.id, type: event.type }, 'Processing webhook event');

  switch (event.type) {
    case 'checkout.session.completed': {
      await handleCheckoutCompleted(event.data.object, ctx);
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      await syncSubscriptionStatus(ctx.client, sub);

      if (
        event.type === 'customer.subscription.updated' &&
        event.data.previous_attributes &&
        'items' in event.data.previous_attributes
      ) {
        await handleSubscriptionItemsChanged(sub, ctx);
      }

      break;
    }

    case 'invoice.paid': {
      await handleInvoicePaid(event.data.object as Stripe.Invoice, ctx);
      break;
    }

    case 'invoice.payment_failed': {
      await handleInvoiceFailed(event.data.object as Stripe.Invoice, ctx);
      break;
    }

    default: {
      log.info({ type: event.type }, 'Unhandled webhook event type');
    }
  }
}

/**
 * Provision the full tenant on `checkout.session.completed` (§9/§15): the
 * signup flow creates only a Supabase auth user and a Stripe
 * checkout session carrying `metadata.userId` + `metadata.tier`. There is no
 * org yet, so we create the whole chain here — app-side user row, organization,
 * owner membership, subscription, capacity — atomically. Idempotent: the
 * event is deduped by `webhook_events`, and within the txn we reuse the user's
 * existing owner org and upsert by `org_id`, so a redelivery is a no-op.
 */
async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  ctx: WebhookContext,
): Promise<void> {
  const stripe = ctx.stripe ?? getStripeClient();

  const userId =
    session.metadata?.userId ??
    (typeof session.client_reference_id === 'string'
      ? session.client_reference_id
      : undefined);
  const tier = session.metadata?.tier;
  const email = session.customer_details?.email ?? session.customer_email ?? undefined;

  if (!userId || !tier) {
    log.warn({ sessionId: session.id }, 'Checkout session missing userId/tier metadata — cannot provision');
    return;
  }
  if (!email) {
    log.warn({ sessionId: session.id }, 'Checkout session has no email — cannot create user row');
    return;
  }
  if (!session.subscription) {
    log.warn({ sessionId: session.id }, 'Checkout session has no subscription');
    return;
  }

  const stripeSubId =
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription.id;
  const stripeCustomerId =
    typeof session.customer === 'string'
      ? session.customer
      : (session.customer?.id ?? null);

  const planRows = await ctx.client<{ id: string; included_gb: number }[]>`
    SELECT id, included_gb FROM plans WHERE tier_key = ${tier} LIMIT 1
  `;
  const plan = planRows[0];
  if (!plan) {
    log.error({ tier }, 'No plan matches tier — cannot provision');
    return;
  }

  // Pull accurate status + period boundary from Stripe (session only has ids).
  let status = 'active';
  let currentPeriodEnd = new Date();
  try {
    const sub = await stripe.subscriptions.retrieve(stripeSubId);
    status = sub.status;
    currentPeriodEnd = new Date(sub.current_period_end * 1000);
  } catch (err) {
    log.warn({ err, stripeSubId }, 'Could not retrieve subscription; using defaults');
  }

  await ctx.client.begin(async (tx) => {
    // 1. App-side user row (id = Supabase auth user id).
    await tx`
      INSERT INTO users (id, email) VALUES (${userId}, ${email})
      ON CONFLICT (id) DO NOTHING
    `;

    // 2. Reuse the user's existing owner org, else create one + owner membership.
    const existingOrg = await tx<{ org_id: string }[]>`
      SELECT org_id FROM memberships
       WHERE user_id = ${userId} AND role = 'owner'
       ORDER BY created_at ASC LIMIT 1
    `;
    let orgId = existingOrg[0]?.org_id;
    if (!orgId) {
      const local =
        (email.split('@')[0] ?? 'org')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'org';
      const slug = `${local}-${userId.slice(0, 8)}`;
      const name = `${email.split('@')[0]}'s Organization`;
      const orgRows = await tx<{ id: string }[]>`
        INSERT INTO organizations (name, slug) VALUES (${name}, ${slug})
        ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
        RETURNING id
      `;
      orgId = orgRows[0]!.id;
      await tx`
        INSERT INTO memberships (org_id, user_id, role)
        VALUES (${orgId}, ${userId}, 'owner')
        ON CONFLICT (org_id, user_id) DO NOTHING
      `;
    }

    // 3. Link the subscription (one per org, §20 #5).
    // C09: before overwriting an existing subscription with a new checkout,
    // cancel the old Stripe subscription so it is not orphaned.
    const existingSub = await tx<{ stripe_subscription_id: string }[]>`
      SELECT stripe_subscription_id FROM subscriptions WHERE org_id = ${orgId}
    `;
    if (existingSub.length > 0 && existingSub[0]!.stripe_subscription_id !== stripeSubId) {
      try {
        await stripe.subscriptions.update(existingSub[0]!.stripe_subscription_id, {
          cancel_at_period_end: true,
          metadata: { replaced_by: stripeSubId },
        });
        log.info({ orgId, oldStripeSubId: existingSub[0]!.stripe_subscription_id, newStripeSubId: stripeSubId }, 'Canceled old Stripe subscription on duplicate checkout');
      } catch (err) {
        log.warn({ err, oldStripeSubId: existingSub[0]!.stripe_subscription_id }, 'Failed to cancel old Stripe subscription during duplicate checkout');
      }
    }

    await tx`
      INSERT INTO subscriptions (org_id, plan_id, stripe_subscription_id, stripe_customer_id, status, current_period_end)
      VALUES (${orgId}, ${plan.id}, ${stripeSubId}, ${stripeCustomerId}, ${status}, ${currentPeriodEnd.toISOString()})
      ON CONFLICT (org_id) DO UPDATE SET
        plan_id = EXCLUDED.plan_id,
        stripe_subscription_id = EXCLUDED.stripe_subscription_id,
        stripe_customer_id = EXCLUDED.stripe_customer_id,
        status = EXCLUDED.status,
        current_period_end = EXCLUDED.current_period_end
    `;

    // 4. Day-one usability: a default bucket. Create the object-storage bucket
    // BEFORE the capacity upsert so that if Hetzner is unreachable we bail early —
    // no DB state is committed that could leave the org with capacity but no
    // backing bucket.
    const existingBucket = await tx<{ id: string }[]>`
      SELECT id FROM buckets WHERE org_id = ${orgId} AND deleted_at IS NULL LIMIT 1
    `;
    if (existingBucket.length === 0) {
      const local =
        (email.split('@')[0] ?? 'media')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'media';
      const bucketName = `${local}-${orgId.slice(0, 8)}`.slice(0, 63);
      const minioBucket = buildBucketName(orgId, bucketName);
      const config = getConfig();

      // Provision the bucket on Hetzner Object Storage using the master
      // credential.
      const s3 = new S3Client({
        endpoint: config.HETZNER_S3_ENDPOINT,
        region: config.HETZNER_S3_REGION,
        credentials: {
          accessKeyId: config.HETZNER_S3_ACCESS_KEY,
          secretAccessKey: config.HETZNER_S3_SECRET_KEY,
        },
        forcePathStyle: true,
      });
      try {
        await s3.send(new CreateBucketCommand({ Bucket: minioBucket }));
      } catch (err: any) {
        const errName = (err as { name?: string })?.name;
        if (errName === "BucketAlreadyOwnedByYou" || errName === "BucketAlreadyExists") {
          // Bucket already exists — safe to proceed.
        } else {
          throw err;
        }
      }
      // Enforce private access (best-effort; ignore errors).
      try {
        await s3.send(new PutPublicAccessBlockCommand({
          Bucket: minioBucket,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        }));
      } catch {
        // best-effort
      }
      await tx`
        INSERT INTO buckets (org_id, name, minio_bucket)
        VALUES (${orgId}, ${bucketName}, ${minioBucket})
        ON CONFLICT DO NOTHING
      `;
    }

    // 5. Provision capacity from the plan's included GB + any active add-ons.
    // Compute allocated_bytes = plan.included_gb + SUM(billing_addons.gb) so
    // redelivery/plan-change checkouts don't silently drop add-on capacity.
    // C03: capacity is upserted AFTER the object-storage bucket exists (step 4).
    const addonRows = await tx<{ total_gb: number }[]>`
      SELECT COALESCE(SUM(gb), 0) AS total_gb FROM billing_addons WHERE org_id = ${orgId}
    `;
    const totalGb = plan.included_gb + (addonRows[0]?.total_gb ?? 0);
    const allocatedBytes = (BigInt(totalGb) * 1_000_000_000n).toString();
    await tx`
      INSERT INTO capacity (org_id, allocated_bytes, used_bytes, auto_enabled,
                            increment_gb, threshold_pct, max_monthly_spend_cents,
                            spend_this_cycle_cents)
      VALUES (${orgId}, ${allocatedBytes}::bigint, 0, false, 10, 80, 0, 0)
      ON CONFLICT (org_id) DO UPDATE
        SET allocated_bytes = ${allocatedBytes}::bigint
    `;

    const existingKey = await tx<{ id: string }[]>`
      SELECT id FROM api_keys WHERE org_id = ${orgId} AND revoked_at IS NULL LIMIT 1
    `;
    if (existingKey.length === 0) {
      const accessKeyId = `ml_${crypto.randomBytes(16).toString('hex')}`;
      const secret = crypto.randomBytes(32).toString('base64url');
      const bearerLookupHash = crypto.createHash('sha256').update(secret).digest('hex');
      const secretEnc = encrypt(secret);
      // read+write only (least privilege): enough to sign preview + upload URLs.
      await tx`
        INSERT INTO api_keys (org_id, name, access_key_id, secret_enc, bearer_lookup_hash, scopes)
        VALUES (${orgId}, 'Default key', ${accessKeyId}, ${secretEnc}, ${bearerLookupHash}, ${['read', 'write']})
      `;
    }

    log.info({ orgId, userId, tier, planId: plan.id }, 'Checkout provisioned org + subscription + capacity + default bucket/key');
  });
}

async function handleSubscriptionItemsChanged(
  sub: Stripe.Subscription,
  ctx: WebhookContext,
): Promise<void> {
  for (const item of sub.items.data) {
    await confirmAddOn(ctx.client, item.id, item.quantity ?? 0);
  }
}

async function handleInvoicePaid(
  invoice: Stripe.Invoice,
  ctx: WebhookContext,
): Promise<void> {
  if (!invoice.subscription) return;

  const stripeSubId =
    typeof invoice.subscription === 'string'
      ? invoice.subscription
      : invoice.subscription.id;

  const subRows = await ctx.client<{ org_id: string }[]>`
    SELECT org_id FROM subscriptions
     WHERE stripe_subscription_id = ${stripeSubId}
  `;

  const subRow = subRows[0];
  if (!subRow) return;

  const orgId = subRow.org_id;

  if (invoice.billing_reason === 'subscription_cycle') {
    await ctx.client`
      UPDATE capacity
         SET spend_this_cycle_cents = 0
       WHERE org_id = ${orgId}
    `;
    log.info({ orgId, stripeSubId }, 'Reset spend counter for new billing cycle');
  }
}

async function handleInvoiceFailed(
  invoice: Stripe.Invoice,
  ctx: WebhookContext,
): Promise<void> {
  if (!invoice.subscription) return;

  const stripeSubId =
    typeof invoice.subscription === 'string'
      ? invoice.subscription
      : invoice.subscription.id;

  await ctx.client`
    UPDATE subscriptions
       SET status = 'past_due'
     WHERE stripe_subscription_id = ${stripeSubId}
  `;

  const orgRows = await ctx.client<{ org_id: string }[]>`
    SELECT org_id FROM subscriptions
     WHERE stripe_subscription_id = ${stripeSubId}
  `;

  const orgRow = orgRows[0];
  if (orgRow) {
    await ctx.client`
      UPDATE capacity SET auto_enabled = false WHERE org_id = ${orgRow.org_id}
    `;
    log.warn(
      {
        orgId: orgRow.org_id,
        stripeSubId,
        invoiceId: invoice.id,
      },
      'Invoice payment failed — subscription marked past_due, auto-capacity disabled',
    );
  }
}
