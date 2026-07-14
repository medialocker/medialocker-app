import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture what each send helper would dispatch, so we can assert on the fully
// rendered subject/html/text without hitting Resend.
const calls: Array<Record<string, any>> = [];
vi.mock('../src/send.js', () => ({
  dispatch: vi.fn(async (input: Record<string, any>) => {
    calls.push(input);
    return { sent: true, id: 'test' };
  }),
}));

import {
  sendWelcomeEmail,
  sendReceiptEmail,
  sendPaymentFailedEmail,
  sendSubscriptionCanceledEmail,
  sendPlanChangedEmail,
  sendCapacityAddedEmail,
  sendContactNotification,
} from '../src/index.js';

beforeEach(() => {
  calls.length = 0;
});

const last = () => calls[calls.length - 1]!;

// No template should leave an unresolved Mustache tag in the output.
const noResidualTags = (s: string) => expect(s).not.toMatch(/\{\{/);

describe('email rendering', () => {
  it('welcome — interpolates org/tier/GB and links the dashboard', async () => {
    await sendWelcomeEmail('u@example.com', {
      orgName: 'Acme Studio',
      tier: 'Pro',
      includedGb: 100,
      dashboardUrl: 'https://app.medialocker.io',
    });
    const c = last();
    expect(c.to).toBe('u@example.com');
    expect(c.subject).toContain('Welcome');
    expect(c.html).toContain('Acme Studio');
    expect(c.html).toContain('100 GB');
    expect(c.html).toContain('https://app.medialocker.io');
    expect(c.text).toContain('Acme Studio');
    noResidualTags(c.html);
    noResidualTags(c.text);
  });

  it('receipt — shows amount + renewal and includes an invoice link when present', async () => {
    await sendReceiptEmail('u@example.com', {
      tier: 'Studio',
      amountFormatted: '$49.00',
      periodEnd: 'August 13, 2026',
      invoiceUrl: 'https://stripe.test/inv_1',
    });
    const c = last();
    expect(c.html).toContain('$49.00');
    expect(c.html).toContain('August 13, 2026');
    expect(c.html).toContain('https://stripe.test/inv_1');
    noResidualTags(c.html);
    noResidualTags(c.text);
  });

  it('payment-failed — states the amount due and links to update payment', async () => {
    await sendPaymentFailedEmail('u@example.com', {
      tier: 'Pro',
      amountDueFormatted: '$19.00',
      updatePaymentUrl: 'https://stripe.test/portal',
    });
    const c = last();
    expect(c.subject.toLowerCase()).toContain('action needed');
    expect(c.html).toContain('$19.00');
    expect(c.html).toContain('https://stripe.test/portal');
    noResidualTags(c.html);
  });

  it('subscription-canceled — shows access-until date', async () => {
    await sendSubscriptionCanceledEmail('u@example.com', {
      tier: 'Pro',
      accessUntil: 'September 1, 2026',
    });
    const c = last();
    expect(c.html).toContain('September 1, 2026');
    noResidualTags(c.html);
    noResidualTags(c.text);
  });

  it('plan-changed — shows from/to tiers', async () => {
    await sendPlanChangedEmail('u@example.com', {
      fromTier: 'Pro',
      toTier: 'Starter',
      effectiveDate: 'August 13, 2026',
    });
    const c = last();
    expect(c.html).toContain('Pro');
    expect(c.html).toContain('Starter');
    noResidualTags(c.html);
  });

  it('capacity-added — auto vs manual copy branch', async () => {
    await sendCapacityAddedEmail('u@example.com', {
      addedGb: 10,
      newTotalGb: 110,
      costFormatted: '$0.20',
      auto: true,
    });
    const auto = last();
    expect(auto.subject).toContain('keep your uploads going');
    expect(auto.html).toContain('automatically added');
    expect(auto.html).toContain('10 GB');
    expect(auto.html).toContain('110 GB');
    noResidualTags(auto.html);

    await sendCapacityAddedEmail('u@example.com', {
      addedGb: 50,
      newTotalGb: 150,
      costFormatted: '$1.00',
      auto: false,
    });
    const manual = last();
    expect(manual.html).not.toContain('automatically added');
    expect(manual.html).toContain('50 GB');
    noResidualTags(manual.html);
  });

  it('contact notification — HTML-escapes the message, nl2br, sets replyTo', async () => {
    await sendContactNotification('support@medialocker.io', {
      name: 'Bob <b>',
      email: 'bob@example.com',
      subject: 'Question about egress',
      message: '<script>alert(1)</script>\nsecond line',
    });
    const c = last();
    expect(c.replyTo).toBe('bob@example.com');
    expect(c.subject).toContain('Question about egress');
    // dangerous input must be escaped, not injected
    expect(c.html).not.toContain('<script>');
    expect(c.html).toContain('&lt;script&gt;');
    // the submitter name is also escaped
    expect(c.html).toContain('Bob &lt;b&gt;');
    // newline became a <br>
    expect(c.html).toContain('<br>');
    // plain-text keeps the raw message
    expect(c.text).toContain('<script>alert(1)</script>');
    noResidualTags(c.html);
  });
});
