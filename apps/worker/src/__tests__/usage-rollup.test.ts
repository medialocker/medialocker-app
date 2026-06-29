import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockSql, makeJob, type RecordedQuery } from './helpers/mock-sql';

/**
 * Drift-reconcile correctness (dev/plan.md §24).
 *
 * The nightly usage rollup recomputes each org's actual stored bytes from
 * `objects` and compares it to the tracked `capacity.used_bytes`. When the
 * relative drift exceeds 0.1% it MUST overwrite `used_bytes` with the actual
 * sum and emit a warning; within-threshold drift must be left untouched.
 */

const warnSpy = vi.fn();
const infoSpy = vi.fn();

const mock = createMockSql();

vi.mock('../db', () => ({
  getDb: () => mock.sql,
}));

// The post-rollup retention trim (P2.40) calls into the real @medialocker/db
// helper, which would otherwise try to open a live connection. Stub it so these
// pure drift-reconcile assertions stay DB-free.
vi.mock('@medialocker/db', () => ({
  trimUsageEventsOlderThan: vi.fn().mockResolvedValue(0n),
}));

vi.mock('../logger', () => ({
  logger: {
    info: (...a: unknown[]) => infoSpy(...a),
    warn: (...a: unknown[]) => warnSpy(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { processUsageRollupJob } from '../processors/usage-rollup';

/** Find any UPDATE capacity ... SET used_bytes statements that were issued. */
function capacityUpdates(queries: RecordedQuery[]): RecordedQuery[] {
  return queries.filter(
    (q) => q.text.includes('UPDATE capacity') && q.text.includes('used_bytes'),
  );
}

beforeEach(() => {
  mock.reset();
  warnSpy.mockClear();
  infoSpy.mockClear();
});

/**
 * Wire the mock so usage_events is empty (skip the rollup loop) and the single
 * grouped reconcile query (capacity LEFT JOIN aggregated object sizes) returns
 * the supplied per-org fixtures as combined rows.
 */
function wireDrift(
  capacities: Array<{ org_id: string; used_bytes: number | string }>,
  actualByOrg: Record<string, number>,
): void {
  mock.onMatch((q) => {
    if (q.text.includes('FROM usage_events')) return [];
    // The reconcile SELECT: `FROM capacity c LEFT JOIN ... AS actual_bytes`.
    if (q.text.includes('FROM capacity') && q.text.includes('actual_bytes')) {
      return capacities.map((c) => ({
        org_id: c.org_id,
        used_bytes: c.used_bytes,
        actual_bytes: actualByOrg[c.org_id] ?? 0,
      }));
    }
    return undefined;
  });
}

describe('usage-rollup drift reconcile', () => {
  it('reconciles an OVER-count: tracked > actual beyond threshold updates capacity', async () => {
    // tracked 1_000_000, actual 900_000 => drift 10% > 0.1%
    wireDrift([{ org_id: 'org-a', used_bytes: 1_000_000 }], { 'org-a': 900_000 });

    await processUsageRollupJob(
      makeJob({ type: 'manual' as const }) as never,
    );

    const updates = capacityUpdates(mock.queries);
    expect(updates).toHaveLength(1);
    // used_bytes is set to the ACTUAL recomputed sum, scoped to the org.
    expect(updates[0]?.params).toEqual([900_000, 'org-a']);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [ctx, msg] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(ctx).toMatchObject({ orgId: 'org-a', actualUsed: 900_000, trackedUsed: 1_000_000 });
    expect(msg).toMatch(/drift detected/i);
  });

  it('reconciles an UNDER-count: tracked < actual beyond threshold updates capacity', async () => {
    // tracked 500_000, actual 750_000 => drift 50% > 0.1%
    wireDrift([{ org_id: 'org-b', used_bytes: 500_000 }], { 'org-b': 750_000 });

    await processUsageRollupJob(
      makeJob({ type: 'manual' as const }) as never,
    );

    const updates = capacityUpdates(mock.queries);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.params).toEqual([750_000, 'org-b']);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT update when drift is within the 0.1% threshold', async () => {
    // tracked 1_000_000, actual 1_000_500 => drift 0.05% < 0.1%
    wireDrift([{ org_id: 'org-c', used_bytes: 1_000_000 }], { 'org-c': 1_000_500 });

    await processUsageRollupJob(
      makeJob({ type: 'manual' as const }) as never,
    );

    expect(capacityUpdates(mock.queries)).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('skips orgs where both tracked and actual are zero (no spurious update)', async () => {
    wireDrift([{ org_id: 'org-d', used_bytes: 0 }], { 'org-d': 0 });

    await processUsageRollupJob(
      makeJob({ type: 'manual' as const }) as never,
    );

    expect(capacityUpdates(mock.queries)).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('reconciles independently per org in a single run', async () => {
    wireDrift(
      [
        { org_id: 'org-x', used_bytes: 1_000_000 }, // actual 1_000_400 -> 0.04% within
        { org_id: 'org-y', used_bytes: 1_000_000 }, // actual 2_000_000 -> 100% drift
      ],
      { 'org-x': 1_000_400, 'org-y': 2_000_000 },
    );

    await processUsageRollupJob(
      makeJob({ type: 'manual' as const }) as never,
    );

    const updates = capacityUpdates(mock.queries);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.params).toEqual([2_000_000, 'org-y']);
  });
});
