import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({}),
  })),
  CreateBucketCommand: vi.fn(),
}));

beforeEach(() => {
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test_secret');
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fake');
});

/**
 * A recording mock of the `postgres` tagged-template client (`Sql`), with
 * `.begin(fn)` running `fn` against the same recorder so transactional queries
 * are captured too. `onQuery(substr, rows)` stubs a result by SQL substring.
 */
function makeRecordingSql() {
  const queries: { text: string; params: unknown[] }[] = [];
  const matchers: Array<{ sub: string; rows: unknown[] }> = [];
  const exec = (strings: TemplateStringsArray, ...params: unknown[]) => {
    const text = strings.join('?');
    queries.push({ text, params });
    const m = matchers.find((x) => text.includes(x.sub));
    return Promise.resolve(m ? m.rows : []);
  };
  const sql: any = (...args: any[]) => (exec as any)(...args);
  sql.begin = async (fn: (tx: any) => Promise<void>) => {
    await fn(sql);
  };
  sql.onQuery = (sub: string, rows: unknown[]) => matchers.push({ sub, rows });
  sql.queries = queries;
  return sql;
}

function checkoutEvent() {
  return {
    id: 'evt_checkout_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_1',
        metadata: { userId: 'user-123', tier: 'pro' },
        customer_email: 'jane@example.com',
        customer: 'cus_1',
        subscription: 'sub_1',
      },
    },
  };
}

describe('handleWebhook', () => {
  it('returns error on invalid signature', async () => {
    const { handleWebhook } = await import('../src/webhook.js');
    const mockStripe = {
      webhooks: {
        constructEvent: () => {
          throw new Error('Invalid signature');
        },
      },
    } as any;

    const result = await handleWebhook('{}', 'sig_bad', {
      client: {} as any,
      stripe: mockStripe,
    });

    expect(result.received).toBe(false);
    expect(result.error).toContain('Signature verification failed');
  });

  it('provisions the full tenant on checkout.session.completed', async () => {
    const { handleWebhook } = await import('../src/webhook.js');
    const sql = makeRecordingSql();
    sql.onQuery('FROM plans WHERE tier_key', [{ id: 'plan-pro', included_gb: 1000 }]);
    sql.onQuery('INTO organizations', [{ id: 'org-new' }]);
    // The atomic dedup claim (INSERT ... ON CONFLICT DO NOTHING RETURNING) returns
    // a row for a NEW event, so processing proceeds. memberships SELECT defaults
    // to [] (new tenant).
    sql.onQuery('INTO webhook_events', [{ event_id: 'evt_checkout_1' }]);

    const mockStripe = {
      webhooks: { constructEvent: () => checkoutEvent() },
      subscriptions: {
        retrieve: vi
          .fn()
          .mockResolvedValue({ status: 'active', current_period_end: 1893456000 }),
      },
    } as any;

    const result = await handleWebhook('{}', 'sig_ok', { client: sql, stripe: mockStripe });

    expect(result.received).toBe(true);
    const texts = sql.queries.map((q: { text: string }) => q.text);
    // The full provisioning chain ran (§9/§15).
    expect(texts.some((t: string) => t.includes('INSERT INTO users'))).toBe(true);
    expect(texts.some((t: string) => t.includes('INSERT INTO organizations'))).toBe(true);
    expect(texts.some((t: string) => t.includes('INSERT INTO memberships'))).toBe(true);
    expect(texts.some((t: string) => t.includes('INSERT INTO subscriptions'))).toBe(true);
    expect(texts.some((t: string) => t.includes('INSERT INTO capacity'))).toBe(true);

    // Subscription is linked to the created org + the tier's plan + Stripe ids.
    const subInsert = sql.queries.find((q: { text: string }) =>
      q.text.includes('INSERT INTO subscriptions'),
    );
    expect(subInsert.params).toContain('org-new');
    expect(subInsert.params).toContain('plan-pro');
    expect(subInsert.params).toContain('sub_1');
    expect(subInsert.params).toContain('cus_1');

    // Capacity allocated from included_gb (1000 GB → 1e12 bytes, decimal GB).
    const capInsert = sql.queries.find((q: { text: string }) =>
      q.text.includes('INSERT INTO capacity'),
    );
    expect(capInsert.params).toContain('1000000000000');
  });

  it('is idempotent: a duplicate event id does no provisioning', async () => {
    const { handleWebhook } = await import('../src/webhook.js');
    const sql = makeRecordingSql();
    // Duplicate event: the ON CONFLICT DO NOTHING claim returns no row, so the
    // handler short-circuits without provisioning.
    sql.onQuery('INTO webhook_events', []);

    const mockStripe = {
      webhooks: { constructEvent: () => checkoutEvent() },
      subscriptions: { retrieve: vi.fn() },
    } as any;

    const result = await handleWebhook('{}', 'sig_ok', { client: sql, stripe: mockStripe });

    expect(result.received).toBe(true);
    const texts = sql.queries.map((q: { text: string }) => q.text);
    expect(texts.some((t: string) => t.includes('INSERT INTO subscriptions'))).toBe(false);
    expect(texts.some((t: string) => t.includes('INSERT INTO organizations'))).toBe(false);
  });

  it('skips provisioning when userId/tier metadata is missing', async () => {
    const { handleWebhook } = await import('../src/webhook.js');
    const sql = makeRecordingSql();
    // Claim succeeds (new event) so dispatch runs and the missing-metadata guard
    // is what skips provisioning.
    sql.onQuery('INTO webhook_events', [{ event_id: 'evt_checkout_1' }]);
    const event = checkoutEvent();
    event.data.object.metadata = {} as any;

    const mockStripe = {
      webhooks: { constructEvent: () => event },
      subscriptions: { retrieve: vi.fn() },
    } as any;

    const result = await handleWebhook('{}', 'sig_ok', { client: sql, stripe: mockStripe });

    expect(result.received).toBe(true);
    const texts = sql.queries.map((q: { text: string }) => q.text);
    expect(texts.some((t: string) => t.includes('INSERT INTO subscriptions'))).toBe(false);
  });
});
