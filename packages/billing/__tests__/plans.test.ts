import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fake');
});

// Recording postgres mock (mirrors auto-capacity.test.ts): captures the
// `UPDATE plans` write syncPlanToStripe issues at the end.
function makeRecordingSql() {
  const queries: { text: string; params: unknown[] }[] = [];
  const exec = (strings: TemplateStringsArray, ...params: unknown[]) => {
    queries.push({ text: strings.join('?'), params });
    return Promise.resolve([]);
  };
  const sql: any = (...args: any[]) => (exec as any)(...args);
  sql.queries = queries;
  return sql;
}

const stripeMock = {
  products: {
    search: vi.fn().mockResolvedValue({ data: [] }),
    create: vi.fn().mockResolvedValue({ id: 'prod_test' }),
    update: vi.fn().mockResolvedValue({}),
  },
  prices: {
    list: vi.fn().mockResolvedValue({ data: [] }),
    create: vi
      .fn()
      .mockResolvedValueOnce({ id: 'price_base' })
      .mockResolvedValueOnce({ id: 'price_addon' }),
    update: vi.fn().mockResolvedValue({}),
  },
};

vi.mock('../src/stripe.js', () => ({
  getStripe: () => stripeMock,
  getStripeClient: () => stripeMock,
  STRIPE_API_VERSION: '2025-02-24.acacia',
}));

describe('syncPlanToStripe', () => {
  beforeEach(() => {
    stripeMock.products.create.mockClear();
    stripeMock.prices.create.mockClear();
  });

  it('bases the recurring Stripe price on base_price_cents, not included_gb * per_gb_price_cents', async () => {
    const { syncPlanToStripe } = await import('../src/plans.js');
    const sql = makeRecordingSql();

    // Starter: base $9.00 (900c). The old derived value would be
    // included_gb * per_gb_price_cents = 100 * 2 = 200c — the bug this guards.
    const synced = await syncPlanToStripe(sql, {
      id: 'plan-starter',
      tier_key: 'starter',
      name: 'Starter',
      included_gb: 100,
      base_price_cents: 900,
      per_gb_price_cents: 2,
      stripe_product_id: null,
      stripe_price_id: null,
      stripe_addon_price_id: null,
    });

    // The FIRST prices.create call is the base recurring price.
    const baseCall = stripeMock.prices.create.mock.calls[0]![0];
    expect(baseCall.unit_amount).toBe(900);
    expect(baseCall.recurring).toEqual({ interval: 'month' });
    expect(baseCall.metadata).toMatchObject({ tier_key: 'starter', type: 'base' });

    // The addon price still tracks the per-GB overage rate (unchanged).
    const addonCall = stripeMock.prices.create.mock.calls[1]![0];
    expect(addonCall.unit_amount_decimal).toBe('2');

    expect(synced.stripe_price_id).toBe('price_base');
    expect(synced.stripe_addon_price_id).toBe('price_addon');
    // The price id is persisted back to the plans row.
    expect(sql.queries.some((q) => q.text.includes('UPDATE plans'))).toBe(true);
  });
});
