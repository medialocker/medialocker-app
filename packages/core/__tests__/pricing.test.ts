import { describe, it, expect, vi } from 'vitest';
import { gbToBytes, bytesToGb, calculateAddOnCost, calculateProratedCost, calculateMonthlyCost, calculatePlanBasePriceCents } from '../src/pricing.js';

describe('gbToBytes', () => {
  it('converts 0 GB to 0 bytes', () => {
    expect(gbToBytes(0)).toBe(BigInt(0));
  });

  it('converts 1 GB to 1,000,000,000 bytes', () => {
    expect(gbToBytes(1)).toBe(BigInt(1_000_000_000));
  });

  it('converts 100 GB to 100,000,000,000 bytes', () => {
    expect(gbToBytes(100)).toBe(BigInt(100_000_000_000));
  });

  it('converts fractional GB (0.5 GB = 500,000,000 bytes)', () => {
    expect(gbToBytes(0.5)).toBe(BigInt(500_000_000));
  });

  it('rounds to nearest byte for fractional GB', () => {
    expect(gbToBytes(0.333333333)).toBe(BigInt(333_333_333));
  });

  it('handles large values (5 TB)', () => {
    expect(gbToBytes(5000)).toBe(BigInt(5_000_000_000_000n));
  });
});

describe('bytesToGb', () => {
  it('converts 0 bytes to 0 GB', () => {
    expect(bytesToGb(BigInt(0))).toBe(0);
  });

  it('converts 1,000,000,000 bytes to 1 GB', () => {
    expect(bytesToGb(BigInt(1_000_000_000))).toBe(1);
  });

  it('converts 500,000,000 bytes to 0.5 GB', () => {
    expect(bytesToGb(BigInt(500_000_000))).toBe(0.5);
  });

  it('converts 100,000,000,000 bytes to 100 GB', () => {
    expect(bytesToGb(BigInt(100_000_000_000))).toBe(100);
  });

  it('converts 1,500,000,000 bytes to 1.5 GB', () => {
    expect(bytesToGb(BigInt(1_500_000_000))).toBe(1.5);
  });
});

describe('calculateAddOnCost', () => {
  it('returns 0 cents for 0 GB', () => {
    expect(calculateAddOnCost(0, 2.4)).toBe(0);
  });

  it('calculates cost at 2.4 cents/GB for 10 GB', () => {
    expect(calculateAddOnCost(10, 2.4)).toBe(24);
  });

  it('calculates cost at 2.4 cents/GB for 100 GB', () => {
    expect(calculateAddOnCost(100, 2.4)).toBe(240);
  });

  it('rounds to nearest cent', () => {
    expect(calculateAddOnCost(3, 2.4)).toBe(7);
  });

  it('calculates at 2.2 cents/GB for 1000 GB', () => {
    expect(calculateAddOnCost(1000, 2.2)).toBe(2200);
  });

  it('calculates at 2.0 cents/GB for 5000 GB', () => {
    expect(calculateAddOnCost(5000, 2.0)).toBe(10000);
  });
});

describe('calculateProratedCost', () => {
  it('returns 0 cost when daysRemaining is 0', () => {
    expect(calculateProratedCost(10, 2.4, 30, 0)).toBe(0);
  });

  it('returns 0 cost when daysInCycle is 0', () => {
    expect(calculateProratedCost(10, 2.4, 0, 15)).toBe(0);
  });

  it('returns full cost when daysRemaining equals daysInCycle', () => {
    expect(calculateProratedCost(10, 2.4, 30, 30)).toBe(24);
  });

  it('prorates to half cost at mid-cycle (15 days remaining of 30)', () => {
    const cost = calculateProratedCost(10, 2.4, 30, 15);
    expect(cost).toBe(12);
  });

  it('prorates to ~10% cost with 3 days remaining of 30', () => {
    const cost = calculateProratedCost(100, 2.4, 30, 3);
    // 100 * 2.4 = 240; 240 * 3 / 30 = 24
    expect(cost).toBe(24);
  });

  it('rounds prorated cost to nearest cent', () => {
    expect(calculateProratedCost(1, 2.4, 31, 1)).toBe(0);
  });
});

describe('calculateMonthlyCost', () => {
  it('calculates total cost for plan GB + add-on GB', () => {
    expect(calculateMonthlyCost(100, 2.4, 50)).toBe(360);
  });

  it('calculates total cost for plan GB only', () => {
    expect(calculateMonthlyCost(100, 2.4, 0)).toBe(240);
  });

  it('calculates total cost for large plans', () => {
    expect(calculateMonthlyCost(1000, 2.2, 500)).toBe(3300);
  });
});

describe('calculatePlanBasePriceCents', () => {
  it('calculates Starter tier (100 GB * 2.4 cents)', () => {
    expect(calculatePlanBasePriceCents(100, 2.4)).toBe(240);
  });

  it('calculates Pro tier (1000 GB * 2.2 cents)', () => {
    expect(calculatePlanBasePriceCents(1000, 2.2)).toBe(2200);
  });

  it('calculates Studio tier (5000 GB * 2.0 cents)', () => {
    expect(calculatePlanBasePriceCents(5000, 2.0)).toBe(10000);
  });
});
