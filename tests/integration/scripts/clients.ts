/**
 * Real clients for the throwaway stack, constructed the same way the apps do in
 * production:
 *
 *  - Postgres via `postgres` (same driver/options shape as packages/db/src
 *    `createClient`). snake_case columns, no camel transform.
 *  - Redis via ioredis against REDIS_URL — same as the backend queue client.
 *
 * There is no S3/object-storage client here: tenant uploads now go
 * browser→Hetzner via presigned URLs (no data plane in-process), and the
 * remaining suites exercise only the capacity/billing SQL paths against
 * Postgres. The HEAD-on-confirm + presign flow is not reachable without live
 * Hetzner credentials, so it is out of scope for this harness.
 *
 * Constructing them here (rather than importing the singletons) lets each test
 * file open and `await end()` its own pool deterministically.
 */
import postgres, { type Sql } from "postgres";
import Redis from "ioredis";
import { getTestEnv, type TestEnv } from "./test-env.js";

export function makeTestSql(env: TestEnv = getTestEnv()): Sql {
  // Mirror packages/db/src createClient(): no `transform: postgres.camel` —
  // every query uses snake_case columns.
  return postgres(env.databaseUrl, {
    max: 10,
    idle_timeout: 5,
    connect_timeout: 10,
    // postgres.js returns int8 (bigint) columns as STRINGS by default. The
    // accounting columns (size, used_bytes, allocated_bytes) are int8 and the
    // suites assert native BigInt, so parse OID 20 → BigInt (and serialize
    // BigInt params back to a string). Scoped to OID 20 only, so NUMERIC
    // columns such as plans.included_gb are untouched.
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: bigint) => x.toString(),
        parse: (x: string) => BigInt(x),
      },
    },
  });
}

export function makeTestRedis(env: TestEnv = getTestEnv()): Redis {
  return new Redis(env.redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
}

/** Read capacity.used_bytes for an org (generic DB read, used by the suites). */
export async function usedBytes(sql: Sql, orgId: string): Promise<bigint> {
  const rows = await sql<{ used_bytes: bigint }[]>`
    SELECT used_bytes FROM capacity WHERE org_id = ${orgId}
  `;
  return rows[0]?.used_bytes ?? 0n;
}
