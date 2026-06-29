import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fake');
});

/**
 * Recording mock of the `postgres` client. `.begin(fn)` runs `fn` against the
 * same recorder, so the nested `addCapacity` transaction (a savepoint in real
 * postgres.js) is captured too. `onQuery(substr, rows)` stubs a result by SQL
 * substring; first matching matcher wins.
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
  sql.begin = async (fn: (tx: any) => Promise<unknown>) => fn(sql);
  sql.onQuery = (sub: string, rows: unknown[]) => matchers.push({ sub, rows });
  sql.queries = queries;
  return sql;
}

const stripeMock = {
  subscriptionItems: {
    list: vi.fn().mockResolvedValue({ data: [] }),
    create: vi.fn().mockResolvedValue({ id: 'si_new', quantity: 10 }),
    update: vi.fn(),
  },
};

vi.mock('../src/stripe.js', () => ({
  getStripe: () => stripeMock,
  getStripeClient: () => stripeMock,
  STRIPE_API_VERSION: '2025-02-24.acacia',
}));

function capRow(over: Record<string, unknown> = {}) {
  return {
    auto_enabled: true,
    used_bytes: 900n,
    allocated_bytes: 1000n,
    threshold_pct: 80,
    increment_gb: 10,
    max_monthly_spend_cents: 100000,
    ...over,
  };
}

describe('autoAddCapacity', () => {
  beforeEach(() => {
    stripeMock.subscriptionItems.list.mockClear();
    stripeMock.subscriptionItems.create.mockClear();
  });

  it('does nothing when auto_enabled is false (and never calls Stripe)', async () => {
    const { autoAddCapacity } = await import('../src/capacity-addons.js');
    const sql = makeRecordingSql();
    sql.onQuery('FROM capacity c', [capRow({ auto_enabled: false })]);

    const res = await autoAddCapacity(sql, 'org-1');

    expect(res.added).toBe(false);
    expect(stripeMock.subscriptionItems.create).not.toHaveBeenCalled();
    expect(sql.queries.some((q: any) => q.text.includes('INSERT INTO billing_addons'))).toBe(false);
  });

  it('does nothing when max monthly spend is 0', async () => {
    const { autoAddCapacity } = await import('../src/capacity-addons.js');
    const sql = makeRecordingSql();
    sql.onQuery('FROM capacity c', [capRow({ max_monthly_spend_cents: 0 })]);

    const res = await autoAddCapacity(sql, 'org-1');
    expect(res.added).toBe(false);
    expect(stripeMock.subscriptionItems.create).not.toHaveBeenCalled();
  });

  it('does nothing when usage is below threshold', async () => {
    const { autoAddCapacity } = await import('../src/capacity-addons.js');
    const sql = makeRecordingSql();
    sql.onQuery('FROM capacity c', [capRow({ used_bytes: 500n })]);

    const res = await autoAddCapacity(sql, 'org-1');
    expect(res.added).toBe(false);
    expect(stripeMock.subscriptionItems.create).not.toHaveBeenCalled();
  });

  it('adds capacity through the billed path: Stripe item + billing_addons row', async () => {
    const { autoAddCapacity } = await import('../src/capacity-addons.js');
    const sql = makeRecordingSql();
    // gating read (autoAddCapacity) — over threshold, auto on, spend cap high.
    sql.onQuery('FROM capacity c', [capRow()]);
    // The atomic debounce claim (UPDATE ... last_auto_add_at ... RETURNING) must
    // return a row so the (non-throttled) add proceeds.
    sql.onQuery('last_auto_add_at', [{ org_id: 'org-1' }]);
    // addCapacity's subscription/plan/capacity join read.
    sql.onQuery('s.stripe_subscription_id', [
      {
        stripe_subscription_id: 'sub_1',
        per_gb_price_cents: 2,
        allocated_bytes: 1000n,
        used_bytes: 900n,
        max_monthly_spend_cents: 100000,
        spend_this_cycle_cents: 0,
        addon_stripe_price_id: 'price_addon_1',
        current_period_end: new Date(Date.now() + 15 * 86_400_000).toISOString(),
      },
    ]);

    const res = await autoAddCapacity(sql, 'org-1');

    expect(res.added).toBe(true);
    expect(res.addedGb).toBe(10);
    expect(stripeMock.subscriptionItems.create).toHaveBeenCalledTimes(1);
    // The add was recorded (billed), not a silent local allocation (§8/§26).
    expect(sql.queries.some((q: any) => q.text.includes('INSERT INTO billing_addons'))).toBe(true);
    expect(sql.queries.some((q: any) => q.text.includes('UPDATE capacity'))).toBe(true);
    // Concurrent adds are serialized under a per-org advisory lock (§24).
    expect(sql.queries.some((q: any) => q.text.includes('pg_advisory_xact_lock'))).toBe(true);
  });
});
