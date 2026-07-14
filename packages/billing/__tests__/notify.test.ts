import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the email package so no rendering/Resend happens — we only assert notify's
// recipient resolution and its best-effort safety. vi.hoisted lets the mock
// factory (hoisted to the top) share these spies with the test body.
const sends = vi.hoisted(() => ({
  sendWelcomeEmail: vi.fn(),
  sendReceiptEmail: vi.fn(),
  sendPaymentFailedEmail: vi.fn(),
  sendSubscriptionCanceledEmail: vi.fn(),
  sendPlanChangedEmail: vi.fn(),
  sendCapacityAddedEmail: vi.fn(),
}));
vi.mock('@medialocker/email', () => sends);

import { notifyWelcome, notifyCapacityAdded, notifyReceipt } from '../src/notify.js';

/** Tagged-template sql mock: resolve rows by SQL substring. */
function makeSql(routes: Array<{ sub: string; rows: unknown[] }>) {
  return (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    const r = routes.find((x) => text.includes(x.sub));
    return Promise.resolve(r ? r.rows : []);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(sends)) fn.mockResolvedValue({ sent: true });
});

describe('notify best-effort safety', () => {
  it('never rejects when a lookup query throws', async () => {
    const throwingSql: any = () => Promise.reject(new Error('db down'));
    await expect(
      notifyWelcome(throwingSql, { orgId: 'o1', to: 'a@b.com', tier: 'Pro', includedGb: 100 }),
    ).resolves.toBeUndefined();
    expect(sends.sendWelcomeEmail).not.toHaveBeenCalled();
  });

  it('never rejects when the email send throws', async () => {
    sends.sendWelcomeEmail.mockRejectedValueOnce(new Error('resend exploded'));
    const sql: any = makeSql([{ sub: 'FROM organizations', rows: [{ name: 'Acme' }] }]);
    await expect(
      notifyWelcome(sql, { orgId: 'o1', to: 'a@b.com', tier: 'Pro', includedGb: 100 }),
    ).resolves.toBeUndefined();
  });
});

describe('notify recipient resolution', () => {
  it('capacity-added emails the resolved org owner with the new total', async () => {
    const sql: any = makeSql([
      { sub: 'FROM memberships', rows: [{ email: 'owner@x.com' }] },
      { sub: 'FROM capacity', rows: [{ allocated_bytes: '110000000000' }] },
    ]);
    await notifyCapacityAdded(sql, { orgId: 'o1', addedGb: 10, costCents: 20, auto: true });
    expect(sends.sendCapacityAddedEmail).toHaveBeenCalledWith(
      'owner@x.com',
      expect.objectContaining({ addedGb: 10, newTotalGb: 110, auto: true, costFormatted: '$0.20' }),
    );
  });

  it('receipt falls back to the org owner when the invoice has no email', async () => {
    const sql: any = makeSql([
      { sub: 'FROM memberships', rows: [{ email: 'owner@x.com' }] },
      { sub: 'FROM subscriptions', rows: [{ name: 'Pro', current_period_end: '2026-08-13' }] },
    ]);
    await notifyReceipt(sql, { orgId: 'o1', to: null, amountCents: 4900, invoiceUrl: null });
    expect(sends.sendReceiptEmail).toHaveBeenCalledWith(
      'owner@x.com',
      expect.objectContaining({ tier: 'Pro', amountFormatted: '$49.00' }),
    );
  });
});
