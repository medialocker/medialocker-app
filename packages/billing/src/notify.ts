import type { Sql } from 'postgres';
import { getConfig } from '@medialocker/config';
import { createLogger } from '@medialocker/observability';
import {
  sendWelcomeEmail,
  sendReceiptEmail,
  sendPaymentFailedEmail,
  sendSubscriptionCanceledEmail,
  sendPlanChangedEmail,
  sendCapacityAddedEmail,
  type SendResult,
} from '@medialocker/email';

const log = createLogger('billing:notify');

/**
 * All lifecycle email is best-effort: a failure must never fail the Stripe
 * webhook (which would make Stripe retry and re-run provisioning) nor a billing
 * API call. This wraps the WHOLE operation — recipient/plan lookups included, not
 * just the send — so even a DB error in the notify path can't throw into the
 * caller. Every helper resolves to void.
 */
async function bestEffort(op: string, fn: () => Promise<SendResult | void>): Promise<void> {
  try {
    const res = await fn();
    if (res && res.error) log.warn({ op, error: res.error }, 'Lifecycle email failed');
  } catch (err) {
    log.error({ err, op }, 'Lifecycle email threw');
  }
}

/** Owner email for an org (fallback recipient when a Stripe object has none). */
export async function getOrgOwnerEmail(client: Sql, orgId: string): Promise<string | null> {
  const rows = await client<{ email: string }[]>`
    SELECT u.email
      FROM memberships m
      JOIN users u ON u.id = m.user_id
     WHERE m.org_id = ${orgId} AND m.role = 'owner'
     ORDER BY m.created_at ASC
     LIMIT 1
  `;
  return rows[0]?.email ?? null;
}

function dashboardUrl(): string {
  return `https://app.${getConfig().PUBLIC_BASE_DOMAIN}`;
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Plan tier name + current period end for an org's active subscription. */
async function getPlanContext(
  client: Sql,
  orgId: string,
): Promise<{ tier: string; periodEnd: Date } | null> {
  const rows = await client<{ name: string; current_period_end: string }[]>`
    SELECT p.name, s.current_period_end
      FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id
     WHERE s.org_id = ${orgId}
     ORDER BY s.id DESC
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return { tier: row.name, periodEnd: new Date(row.current_period_end) };
}

/** Current allocated capacity for an org, in GB (rounded). */
async function getAllocatedGb(client: Sql, orgId: string): Promise<number> {
  const rows = await client<{ allocated_bytes: string }[]>`
    SELECT allocated_bytes::text FROM capacity WHERE org_id = ${orgId}
  `;
  const bytes = rows[0]?.allocated_bytes;
  return bytes ? Math.round(Number(bytes) / 1e9) : 0;
}

export function notifyWelcome(
  client: Sql,
  input: { orgId: string; to: string; tier: string; includedGb: number },
): Promise<void> {
  return bestEffort('welcome', async () => {
    const orgRows = await client<{ name: string }[]>`
      SELECT name FROM organizations WHERE id = ${input.orgId} LIMIT 1
    `;
    const orgName = orgRows[0]?.name ?? 'Your organization';
    return sendWelcomeEmail(input.to, {
      orgName,
      tier: input.tier,
      includedGb: input.includedGb,
      dashboardUrl: dashboardUrl(),
    });
  });
}

export function notifyReceipt(
  client: Sql,
  input: { orgId: string; to?: string | null; amountCents: number; invoiceUrl?: string | null },
): Promise<void> {
  return bestEffort('receipt', async () => {
    const to = input.to ?? (await getOrgOwnerEmail(client, input.orgId));
    if (!to) {
      log.warn({ orgId: input.orgId }, 'No recipient for receipt email');
      return;
    }
    const ctx = await getPlanContext(client, input.orgId);
    return sendReceiptEmail(to, {
      tier: ctx?.tier ?? 'your plan',
      amountFormatted: formatUsd(input.amountCents),
      periodEnd: ctx ? formatDate(ctx.periodEnd) : '',
      invoiceUrl: input.invoiceUrl ?? undefined,
    });
  });
}

export function notifyPaymentFailed(
  client: Sql,
  input: { orgId: string; to?: string | null; amountDueCents: number; updateUrl?: string | null },
): Promise<void> {
  return bestEffort('payment_failed', async () => {
    const to = input.to ?? (await getOrgOwnerEmail(client, input.orgId));
    if (!to) {
      log.warn({ orgId: input.orgId }, 'No recipient for payment-failed email');
      return;
    }
    const ctx = await getPlanContext(client, input.orgId);
    return sendPaymentFailedEmail(to, {
      tier: ctx?.tier ?? 'your plan',
      amountDueFormatted: formatUsd(input.amountDueCents),
      updatePaymentUrl: input.updateUrl ?? `${dashboardUrl()}/settings/billing`,
    });
  });
}

export function notifyCanceled(client: Sql, stripeSubId: string): Promise<void> {
  return bestEffort('canceled', async () => {
    const subRows = await client<{ org_id: string }[]>`
      SELECT org_id FROM subscriptions WHERE stripe_subscription_id = ${stripeSubId} LIMIT 1
    `;
    const orgId = subRows[0]?.org_id;
    if (!orgId) return;
    const to = await getOrgOwnerEmail(client, orgId);
    if (!to) {
      log.warn({ orgId }, 'No recipient for cancellation email');
      return;
    }
    const ctx = await getPlanContext(client, orgId);
    return sendSubscriptionCanceledEmail(to, {
      tier: ctx?.tier ?? 'your plan',
      accessUntil: ctx ? formatDate(ctx.periodEnd) : '',
    });
  });
}

export function notifyCapacityAdded(
  client: Sql,
  input: { orgId: string; addedGb: number; costCents: number; auto: boolean },
): Promise<void> {
  return bestEffort('capacity_added', async () => {
    const to = await getOrgOwnerEmail(client, input.orgId);
    if (!to) {
      log.warn({ orgId: input.orgId }, 'No recipient for capacity-added email');
      return;
    }
    const newTotalGb = await getAllocatedGb(client, input.orgId);
    return sendCapacityAddedEmail(to, {
      addedGb: input.addedGb,
      newTotalGb,
      costFormatted: formatUsd(input.costCents),
      auto: input.auto,
    });
  });
}

export function notifyPlanChanged(
  client: Sql,
  input: { orgId: string; fromTier: string; toTier: string },
): Promise<void> {
  return bestEffort('plan_changed', async () => {
    const to = await getOrgOwnerEmail(client, input.orgId);
    if (!to) {
      log.warn({ orgId: input.orgId }, 'No recipient for plan-changed email');
      return;
    }
    return sendPlanChangedEmail(to, {
      fromTier: input.fromTier,
      toTier: input.toTier,
      effectiveDate: formatDate(new Date()),
    });
  });
}
