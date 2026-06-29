import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockSql, makeJob, type RecordedQuery } from './helpers/mock-sql';

/**
 * Billing reconciliation detects drift between Stripe subscription state and
 * the local DB (capacity add-ons / allocated bytes) and corrects the GB
 * mismatch in `billing_addons`.
 */

const warnSpy = vi.fn();
const retrieve = vi.fn();

vi.mock('@medialocker/config', () => ({
  getConfig: () => ({ STRIPE_SECRET_KEY: 'sk_test_123' }),
}));

vi.mock('@medialocker/billing', () => ({
  getStripeClient: () => ({
    subscriptions: { retrieve },
  }),
}));

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: (...a: unknown[]) => warnSpy(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mock = createMockSql();
vi.mock('../db', () => ({
  getDb: () => mock.sql,
}));

// The storage reconcile pass (P2.41) lists MinIO buckets. Mock the S3 layer so
// these Stripe-focused tests don't touch real storage; the `buckets` query is
// driven by the mock SQL (default empty → storage reconcile is a no-op here).
const s3SendSpy = vi.fn();
vi.mock('../s3', () => ({
  getS3: () => ({ send: s3SendSpy }),
  refreshS3Client: vi.fn().mockResolvedValue(undefined),
}));

import {
  processBillingReconcileJob,
  reconcileStorageAgainstMinio,
} from '../processors/billing-reconcile';

function stripeSub(items: Array<{ id: string; quantity: number; gb: string }>) {
  return {
    items: {
      data: items.map((i) => ({
        id: i.id,
        quantity: i.quantity,
        price: { metadata: { type: 'capacity_addon', gb: i.gb } },
      })),
    },
  };
}

function warnMsgs(): string[] {
  return warnSpy.mock.calls.map((c) => (c as [unknown, string])[1]);
}

function addonUpdates(queries: RecordedQuery[]): RecordedQuery[] {
  return queries.filter(
    (q) => q.text.includes('UPDATE billing_addons') && q.text.includes('gb'),
  );
}

beforeEach(() => {
  mock.reset();
  warnSpy.mockClear();
  retrieve.mockReset();
  s3SendSpy.mockReset();
});

describe('processBillingReconcileJob', () => {
  it('flags + corrects a GB mismatch between Stripe and the DB add-on', async () => {
    mock.onQuery('FROM subscriptions', [
      {
        org_id: 'org-1',
        stripe_subscription_id: 'sub_1',
        plan_id: 'plan-1',
        status: 'active',
        allocated_bytes: 0,
        used_bytes: 0,
      },
    ]);
    // DB says this add-on is 5 GB...
    mock.onQuery('FROM billing_addons', [{ id: 'addon-1', stripe_item_id: 'si_1', gb: 5 }]);
    // ...but Stripe says 10 (gb=10 * quantity=1).
    retrieve.mockResolvedValue(stripeSub([{ id: 'si_1', quantity: 1, gb: '10' }]));

    await processBillingReconcileJob(makeJob({ type: 'manual' as const }) as never);

    expect(warnMsgs()).toContain('GB mismatch between DB and Stripe addon — distributing difference across rows iteratively');
    const updates = addonUpdates(mock.queries);
    expect(updates).toHaveLength(1);
    // Group SUM(5) vs Stripe expected 10 → consolidate the +5 onto the oldest row
    // (id=addon-1) WITHOUT rewriting every sibling row to the total. (C1)
    // UPDATE billing_addons SET gb = 10 WHERE id = addon-1
    expect(updates[0]?.params).toEqual([10, 'addon-1']);
  });

  it('does NOT double the ledger when ≥2 add-ons share one Stripe item (C1)', async () => {
    mock.onQuery('FROM subscriptions', [
      {
        org_id: 'org-multi',
        stripe_subscription_id: 'sub_multi',
        plan_id: 'plan-1',
        status: 'active',
        allocated_bytes: 0,
        used_bytes: 0,
      },
    ]);
    // Two add-on rows (50 + 50 = 100 GB) sharing ONE Stripe item si_1...
    mock.onQuery('FROM billing_addons', [
      { id: 'a-1', stripe_item_id: 'si_1', gb: 50 },
      { id: 'a-2', stripe_item_id: 'si_1', gb: 50 },
    ]);
    // ...and Stripe agrees: gb=100 * quantity=1 = 100 GB total.
    retrieve.mockResolvedValue(stripeSub([{ id: 'si_1', quantity: 1, gb: '100' }]));

    await processBillingReconcileJob(makeJob({ type: 'manual' as const }) as never);

    // The old code matched only the first row, then UPDATE ... WHERE stripe_item_id
    // rewrote BOTH rows to 100 (SUM=200, doubled). The grouped reconcile compares
    // SUM(50+50)=100 to the expected 100 and issues NO update.
    expect(addonUpdates(mock.queries)).toHaveLength(0);
  });

  it('does NOT update when DB and Stripe GB agree', async () => {
    mock.onQuery('FROM subscriptions', [
      {
        org_id: 'org-2',
        stripe_subscription_id: 'sub_2',
        plan_id: 'plan-1',
        status: 'active',
        allocated_bytes: 0,
        used_bytes: 0,
      },
    ]);
    mock.onQuery('FROM billing_addons', [{ stripe_item_id: 'si_2', gb: 20 }]);
    retrieve.mockResolvedValue(stripeSub([{ id: 'si_2', quantity: 2, gb: '10' }]));

    await processBillingReconcileJob(makeJob({ type: 'manual' as const }) as never);

    expect(addonUpdates(mock.queries)).toHaveLength(0);
    expect(warnMsgs()).not.toContain('GB mismatch between DB and Stripe addon');
  });

  it('flags a DB add-on that is absent from the Stripe subscription as drift', async () => {
    mock.onQuery('FROM subscriptions', [
      {
        org_id: 'org-3',
        stripe_subscription_id: 'sub_3',
        plan_id: 'plan-1',
        status: 'active',
        allocated_bytes: 0,
        used_bytes: 0,
      },
    ]);
    mock.onQuery('FROM billing_addons', [{ stripe_item_id: 'si_ghost', gb: 5 }]);
    retrieve.mockResolvedValue(stripeSub([])); // no items in Stripe

    await processBillingReconcileJob(makeJob({ type: 'manual' as const }) as never);

    expect(warnMsgs()).toContain(
      'DB addon not found in Stripe subscription — possible drift',
    );
  });

  it('flags a Stripe add-on that is absent from billing_addons as drift', async () => {
    mock.onQuery('FROM subscriptions', [
      {
        org_id: 'org-4',
        stripe_subscription_id: 'sub_4',
        plan_id: 'plan-1',
        status: 'active',
        allocated_bytes: 0,
        used_bytes: 0,
      },
    ]);
    mock.onQuery('FROM billing_addons', []); // DB has no add-ons
    retrieve.mockResolvedValue(stripeSub([{ id: 'si_new', quantity: 1, gb: '10' }]));

    await processBillingReconcileJob(makeJob({ type: 'manual' as const }) as never);

    expect(warnMsgs()).toContain(
      'Stripe addon not found in billing_addons — possible drift',
    );
    // Cannot UPDATE a row that does not exist — no correction issued.
    expect(addonUpdates(mock.queries)).toHaveLength(0);
  });

  describe('reconcileStorageAgainstMinio (P2.41)', () => {
    it('pages MinIO objects and warns when physical bytes drift from tracked usage', async () => {
      mock.onQuery('FROM buckets', [{ org_id: 'org-1', minio_bucket: 'ml-org-1' }]);
      mock.onQuery('FROM capacity', [{ used_bytes: '1000' }]); // tracked 1 KB
      // Two-page listing; physical total = 50 MB >> tracked 1 KB → drift warning.
      s3SendSpy
        .mockResolvedValueOnce({
          Contents: [{ Size: 25_000_000 }],
          IsTruncated: true,
          NextContinuationToken: 'tok',
        })
        .mockResolvedValueOnce({
          Contents: [{ Size: 25_000_000 }],
          IsTruncated: false,
        });

      await reconcileStorageAgainstMinio(mock.sql, { jobId: 'job-1' });

      expect(s3SendSpy).toHaveBeenCalledTimes(2);
      expect(warnMsgs()).toContain(
        'Storage reconcile: MinIO physical bytes drift from tracked usage — investigate orphaned/leaked storage',
      );
    });

    it('does NOT warn when physical bytes match tracked usage within tolerance', async () => {
      mock.onQuery('FROM buckets', [{ org_id: 'org-2', minio_bucket: 'ml-org-2' }]);
      mock.onQuery('FROM capacity', [{ used_bytes: '10000000' }]); // 10 MB
      s3SendSpy.mockResolvedValueOnce({
        Contents: [{ Size: 10_000_000 }],
        IsTruncated: false,
      });

      await reconcileStorageAgainstMinio(mock.sql, { jobId: 'job-1' });

      expect(warnMsgs()).not.toContain(
        'Storage reconcile: MinIO physical bytes drift from tracked usage — investigate orphaned/leaked storage',
      );
    });

    it('skips an org whose bucket listing fails (no false drift)', async () => {
      mock.onQuery('FROM buckets', [{ org_id: 'org-3', minio_bucket: 'gone' }]);
      s3SendSpy.mockRejectedValueOnce(new Error('NoSuchBucket'));

      await reconcileStorageAgainstMinio(mock.sql, { jobId: 'job-1' });

      expect(warnMsgs()).toContain(
        'Storage reconcile: failed to list MinIO bucket — skipping its bytes',
      );
      expect(warnMsgs()).not.toContain(
        'Storage reconcile: MinIO physical bytes drift from tracked usage — investigate orphaned/leaked storage',
      );
    });
  });

  it('short-circuits the STRIPE billing reconcile when STRIPE_SECRET_KEY is absent', async () => {
    // Re-mock config to drop the key for this case.
    vi.resetModules();
    vi.doMock('@medialocker/config', () => ({ getConfig: () => ({}) }));
    const localSql = createMockSql();
    // Storage reconcile (P2.41) runs regardless of Stripe; drive its `buckets`
    // query to empty so it is a no-op and issues no S3 calls.
    localSql.onQuery('FROM buckets', []);
    vi.doMock('../db', () => ({ getDb: () => localSql.sql }));
    vi.doMock('../s3', () => ({
      getS3: () => ({ send: vi.fn() }),
      refreshS3Client: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const { processBillingReconcileJob: proc } = await import(
      '../processors/billing-reconcile'
    );
    await proc(makeJob({ type: 'manual' as const }) as never);

    // The STRIPE reconcile is skipped (no subscriptions/billing_addons queries),
    // but the Stripe-independent storage reconcile still runs its `buckets` scan.
    expect(localSql.queries.some((q) => q.text.includes('FROM subscriptions'))).toBe(false);
    expect(localSql.queries.some((q) => q.text.includes('FROM billing_addons'))).toBe(false);
    expect(localSql.queries.some((q) => q.text.includes('FROM buckets'))).toBe(true);
    vi.resetModules();
    vi.doUnmock('@medialocker/config');
    vi.doUnmock('../db');
    vi.doUnmock('../s3');
    vi.doUnmock('../logger');
  });
});
