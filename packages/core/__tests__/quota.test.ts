import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reserveCapacity, releaseCapacity, reconcileCapacity, getCapacity, canDowngrade } from '../src/quota.js';

type MockSql = ReturnType<typeof createMockSql>;

function createMockSql() {
  const mockQuery = vi.fn();

  const sql = function (_strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> {
    return mockQuery(_strings, ..._values);
  };

  sql.begin = vi.fn(async (fn: (tx: typeof sql) => Promise<unknown>) => {
    const tx = function (
      _strings: TemplateStringsArray,
      ..._values: unknown[]
      ): Promise<unknown[]> {
      return mockQuery(_strings, ..._values);
    };
    return fn(tx as typeof sql);
  }) as unknown as typeof sql.begin;

  return { sql: sql as any, mockQuery };
}

function b(value: number | bigint): bigint {
  return BigInt(value);
}

describe('reserveCapacity', () => {
  let mock: MockSql;

  beforeEach(() => {
    mock = createMockSql();
  });

  it('returns success when UPDATE returns a row', async () => {
    mock.mockQuery.mockResolvedValueOnce([{ used_bytes: b(1000) }]);

    const result = await reserveCapacity(mock.sql, 'org-1', b(500));
    expect(result).toEqual({ success: true, newUsed: b(1000) });
  });

  it('returns failure when UPDATE returns no rows (over quota)', async () => {
    mock.mockQuery.mockResolvedValueOnce([]);

    const result = await reserveCapacity(mock.sql, 'org-1', b(500));
    expect(result).toEqual({ success: false, newUsed: b(0) });
  });

  it('uses atomic SQL with correct WHERE guard', async () => {
    mock.mockQuery.mockResolvedValueOnce([{ used_bytes: b(750) }]);

    await reserveCapacity(mock.sql, 'org-abc', b(250));

    expect(mock.mockQuery).toHaveBeenCalledTimes(1);
    const callArgs = mock.mockQuery.mock.calls[0] as [string[], ...unknown[]];
    expect(callArgs[0]).toBeInstanceOf(Array);
    const strings: string[] = callArgs[0];
    expect(strings.join('')).toContain('UPDATE capacity');
    expect(strings.join('')).toContain('used_bytes +');
    expect(strings.join('')).toContain('<= allocated_bytes');
  });
});

describe('releaseCapacity', () => {
  let mock: MockSql;

  beforeEach(() => {
    mock = createMockSql();
  });

  it('executes release with GREATEST(0, ...)', async () => {
    mock.mockQuery.mockResolvedValueOnce([]);

    await releaseCapacity(mock.sql, 'org-1', b(500));

    expect(mock.mockQuery).toHaveBeenCalledTimes(1);
    const callArgs = mock.mockQuery.mock.calls[0] as [string[], ...unknown[]];
    const strings: string[] = callArgs[0];
    expect(strings.join('')).toContain('GREATEST(0');
    expect(strings.join('')).toContain('used_bytes -');
  });

  it('does not throw on release', async () => {
    mock.mockQuery.mockResolvedValueOnce([]);
    await expect(
      releaseCapacity(mock.sql, 'org-1', b(500)),
    ).resolves.toBeUndefined();
  });
});

describe('reconcileCapacity', () => {
  let mock: MockSql;

  beforeEach(() => {
    mock = createMockSql();
  });

  it('adjusts by the difference between actual and reserved', async () => {
    mock.mockQuery.mockResolvedValueOnce([]);

    await reconcileCapacity(mock.sql, 'org-1', b(1200), b(1000));

    expect(mock.mockQuery).toHaveBeenCalledTimes(1);
  });

  it('can handle negative adjustment (actual < reserved)', async () => {
    mock.mockQuery.mockResolvedValueOnce([]);

    await reconcileCapacity(mock.sql, 'org-1', b(800), b(1000));

    expect(mock.mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('getCapacity', () => {
  let mock: MockSql;

  beforeEach(() => {
    mock = createMockSql();
  });

  it('returns capacity info when row exists', async () => {
    mock.mockQuery.mockResolvedValueOnce([
      { allocated_bytes: b(1_000_000_000), used_bytes: b(300_000_000) },
    ]);

    const cap = await getCapacity(mock.sql, 'org-1');

    expect(cap.allocatedBytes).toBe(b(1_000_000_000));
    expect(cap.usedBytes).toBe(b(300_000_000));
    expect(cap.freeBytes).toBe(b(700_000_000));
    expect(cap.usagePercent).toBe(30);
  });

  it('returns zeros when no capacity row exists', async () => {
    mock.mockQuery.mockResolvedValueOnce([]);

    const cap = await getCapacity(mock.sql, 'org-1');

    expect(cap.allocatedBytes).toBe(b(0));
    expect(cap.usedBytes).toBe(b(0));
    expect(cap.freeBytes).toBe(b(0));
    expect(cap.usagePercent).toBe(0);
  });

  it('returns 0% usagePercent when allocated is 0', async () => {
    mock.mockQuery.mockResolvedValueOnce([
      { allocated_bytes: b(0), used_bytes: b(100) },
    ]);

    const cap = await getCapacity(mock.sql, 'org-1');
    expect(cap.usagePercent).toBe(0);
  });

  it('returns zero freeBytes when usage exceeds allocated', async () => {
    mock.mockQuery.mockResolvedValueOnce([
      { allocated_bytes: b(1000), used_bytes: b(2000) },
    ]);

    const cap = await getCapacity(mock.sql, 'org-1');
    expect(cap.freeBytes).toBe(b(0));
  });
});

// Auto-capacity moved to `@medialocker/billing` (`autoAddCapacity`) so adds are
// billed through Stripe; see packages/billing/__tests__/auto-capacity.test.ts.

describe('canDowngrade', () => {
  let mock: MockSql;

  beforeEach(() => {
    mock = createMockSql();
  });

  it('returns allowed: true when usage fits within target plan', async () => {
    mock.mockQuery.mockResolvedValueOnce([
      {
        included_gb: 1000,
        per_gb_price_cents: 2.2,
        allocated_bytes: b(500_000_000),
        used_bytes: b(200_000_000),
      },
    ]);

    const result = await canDowngrade(mock.sql, 'org-1', 'plan-pro');
    expect(result).toEqual({ allowed: true });
  });

  it('returns not allowed when usage exceeds target plan', async () => {
    mock.mockQuery.mockResolvedValueOnce([
      {
        included_gb: 10,
        per_gb_price_cents: 2.2,
        allocated_bytes: b(5_000_000_000),
        used_bytes: b(50_000_000_000),
      },
    ]);

    const result = await canDowngrade(mock.sql, 'org-1', 'plan-small');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.excessGb).toBeGreaterThan(0);
  });

  it('returns not allowed when plan or capacity not found', async () => {
    mock.mockQuery.mockResolvedValueOnce([]);

    const result = await canDowngrade(mock.sql, 'org-1', 'plan-missing');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('allows downgrade when usage equals target exactly', async () => {
    mock.mockQuery.mockResolvedValueOnce([
      {
        included_gb: 100,
        per_gb_price_cents: 2.4,
        allocated_bytes: b(100_000_000_000),
        used_bytes: b(100_000_000_000),
      },
    ]);

    const result = await canDowngrade(mock.sql, 'org-1', 'plan-100');
    expect(result.allowed).toBe(true);
  });
});
