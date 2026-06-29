import { describe, it, expect } from 'vitest';
import { BillingReconcileJobSchema } from '../billing-reconcile';

describe('BillingReconcileJobSchema', () => {
  it('accepts nightly type', () => {
    const result = BillingReconcileJobSchema.safeParse({ type: 'nightly' });
    expect(result.success).toBe(true);
  });

  it('accepts manual type', () => {
    const result = BillingReconcileJobSchema.safeParse({ type: 'manual' });
    expect(result.success).toBe(true);
  });

  it('rejects unknown type values', () => {
    const result = BillingReconcileJobSchema.safeParse({ type: 'hourly' });
    expect(result.success).toBe(false);
  });

  it('rejects empty type', () => {
    const result = BillingReconcileJobSchema.safeParse({ type: '' });
    expect(result.success).toBe(false);
  });

  it('rejects missing type field', () => {
    const result = BillingReconcileJobSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects non-string type', () => {
    const result = BillingReconcileJobSchema.safeParse({ type: true });
    expect(result.success).toBe(false);
  });

  it('silently strips extra fields (zod object default behavior)', () => {
    const result = BillingReconcileJobSchema.safeParse({
      type: 'manual',
      extra: 'not-allowed',
    });
    expect(result.success).toBe(true);
  });

  it('rejects null type', () => {
    const result = BillingReconcileJobSchema.safeParse({ type: null });
    expect(result.success).toBe(false);
  });
});
