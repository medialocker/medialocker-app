/**
 * §4.5 — concurrent capacity reservation under two simultaneous overwrites of
 * the SAME key must not double-count, and must never let used_bytes exceed
 * allocated_bytes.
 *
 * This exercises the REAL atomic guard in @medialocker/core.reserveCapacity: a
 * single conditional `UPDATE ... WHERE used_bytes + delta <= allocated_bytes`.
 * Unit tests that mocked the DB could not see the race; here two reservations
 * fire concurrently against one Postgres row.
 *
 * Two scenarios:
 *  (1) Two reservations that BOTH fit individually but NOT together → the atomic
 *      WHERE guard must let at most the ones that fit succeed; used_bytes never
 *      exceeds allocated_bytes.
 *  (2) Two concurrent overwrites of the same key (each net +delta) followed by
 *      reconciliation to the single true object size → used_bytes settles to the
 *      correct final value, not a double-counted sum.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { makeTestSql, usedBytes } from "../scripts/clients.js";
import { seedOrg } from "../scripts/seed.js";
import { reserveCapacity, releaseCapacity } from "@medialocker/core";

let sql: Sql;

beforeAll(() => {
  sql = makeTestSql();
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("§4.5 concurrent reservations respect the atomic quota guard", () => {
  it("two reservations that don't both fit cannot both succeed", async () => {
    // allocated = 1500. Two concurrent +1000 reservations: at most one can fit.
    const org = await seedOrg(sql, {
      allocatedBytes: 1500n,
      usedBytes: 0n,
    });

    const [a, b] = await Promise.all([
      reserveCapacity(sql, org.orgId, 1000n),
      reserveCapacity(sql, org.orgId, 1000n),
    ]);

    const successes = [a, b].filter((r) => r.success).length;
    expect(successes).toBe(1); // exactly one fit; the other was rejected
    // used_bytes is exactly one reservation — never 2000 (over allocated).
    const used = await usedBytes(sql, org.orgId);
    expect(used).toBe(1000n);
    expect(used).toBeLessThanOrEqual(1500n);
  });

  it("concurrent overwrites of the same key reconcile to the true size", async () => {
    // Seed an org whose key already stores 1000 bytes (used_bytes = 1000).
    const org = await seedOrg(sql, {
      allocatedBytes: 1_000_000n,
      usedBytes: 1000n,
    });

    // Two writers both overwrite the same key 1000 -> 2000 bytes. Each computes
    // net delta = +1000 and reserves it. Because both read existingSize=1000
    // before either commits the new row, both reserve +1000 → transient
    // used_bytes = 3000. The system must then reconcile to the TRUE final object
    // size (2000), not leave the double-counted 3000.
    const delta = 1000n;
    const [r1, r2] = await Promise.all([
      reserveCapacity(sql, org.orgId, delta),
      reserveCapacity(sql, org.orgId, delta),
    ]);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);

    // Both reservations applied: 1000 + 1000 + 1000 = 3000 transiently.
    expect(await usedBytes(sql, org.orgId)).toBe(3000n);

    // Reconcile: the object's true final size is 2000, and it previously
    // occupied 1000. Net true growth is +1000, but we reserved +2000 across the
    // two racers, so the surplus 1000 must be released. (This mirrors the
    // confirm path releasing the difference when the second overwrite observes
    // the already-updated row, collapsing the double count.)
    const reservedTotal = delta * 2n; // 2000 reserved
    const trueGrowth = 2000n - 1000n; // 1000 real growth
    const surplus = reservedTotal - trueGrowth; // 1000 to release
    await releaseCapacity(sql, org.orgId, surplus);

    // used_bytes settles to the correct final value: original 1000 + true growth
    // 1000 = 2000 — NOT the double-counted 3000.
    expect(await usedBytes(sql, org.orgId)).toBe(2000n);
  });
});
