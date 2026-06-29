const BYTES_PER_GB = 1_000_000_000;

export function gbToBytes(gb: number): bigint {
  return BigInt(Math.round(gb * BYTES_PER_GB));
}

export function bytesToGb(bytes: bigint): number {
  return Number(bytes) / BYTES_PER_GB;
}

export function calculateAddOnCost(gb: number, perGbPriceCents: number): number {
  return Math.round(gb * perGbPriceCents);
}

export function calculateProratedCost(
  gb: number,
  perGbPriceCents: number,
  daysInCycle: number,
  daysRemaining: number,
): number {
  if (daysInCycle <= 0) return 0;
  if (daysRemaining <= 0) return 0;
  const fullCost = gb * perGbPriceCents;
  return Math.round((fullCost * daysRemaining) / daysInCycle);
}

export function calculateMonthlyCost(
  planIncludedGb: number,
  perGbPriceCents: number,
  addOnGb: number,
): number {
  return calculateAddOnCost(planIncludedGb + addOnGb, perGbPriceCents);
}

export function calculatePlanBasePriceCents(
  includedGb: number,
  perGbPriceCents: number,
): number {
  return Math.round(includedGb * perGbPriceCents);
}
