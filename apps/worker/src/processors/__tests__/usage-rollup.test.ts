import { describe, it, expect } from 'vitest';
import { UsageRollupJobSchema } from '../usage-rollup';

describe('UsageRollupJobSchema', () => {
  it('accepts periodic type', () => {
    const result = UsageRollupJobSchema.safeParse({ type: 'periodic' });
    expect(result.success).toBe(true);
  });

  it('accepts manual type', () => {
    const result = UsageRollupJobSchema.safeParse({ type: 'manual' });
    expect(result.success).toBe(true);
  });

  it('accepts periodic type with optional periodStart and periodEnd', () => {
    const result = UsageRollupJobSchema.safeParse({
      type: 'periodic',
      periodStart: '2025-01-01T00:00:00.000Z',
      periodEnd: '2025-01-02T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts manual type with optional period bounds', () => {
    const result = UsageRollupJobSchema.safeParse({
      type: 'manual',
      periodStart: '2025-06-01T00:00:00Z',
      periodEnd: '2025-06-02T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts manual type with only periodStart', () => {
    const result = UsageRollupJobSchema.safeParse({
      type: 'manual',
      periodStart: '2025-01-01T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts periodic type with only periodEnd', () => {
    const result = UsageRollupJobSchema.safeParse({
      type: 'periodic',
      periodEnd: '2025-01-02T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown type values', () => {
    const result = UsageRollupJobSchema.safeParse({ type: 'daily' });
    expect(result.success).toBe(false);
  });

  it('rejects empty type', () => {
    const result = UsageRollupJobSchema.safeParse({ type: '' });
    expect(result.success).toBe(false);
  });

  it('rejects missing type field', () => {
    const result = UsageRollupJobSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects non-string type', () => {
    const result = UsageRollupJobSchema.safeParse({ type: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects non-string periodStart', () => {
    const result = UsageRollupJobSchema.safeParse({
      type: 'periodic',
      periodStart: 123,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-string periodEnd', () => {
    const result = UsageRollupJobSchema.safeParse({
      type: 'periodic',
      periodEnd: 456,
    });
    expect(result.success).toBe(false);
  });
});
