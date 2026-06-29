# Integration Test Harness

Exercises the capacity-accounting and billing code paths against **real
Postgres**, closing the structural gap that let metering/money bugs ship: the
unit suites mock the DB, so a wrong SQL `used_bytes`/`allocated_bytes` update or
a mis-prorated add-on cost passed green.

These tests live **outside** every package's own `vitest` run. `pnpm test`
(turbo) does **not** execute them. They run only via `pnpm test:integration`
from the repo root.

> **Scope note.** The custom S3 data plane (`apps/s3-gateway`) and its local
> MinIO container are gone. Tenant uploads now go browser→Hetzner via presigned
> URLs (`POST /api/presign/upload` → PUT to storage → `POST /api/presign/confirm`,
> which HEADs the object, writes the `objects` row, applies capacity, and
> enqueues `media:probe`). That data plane is not reachable without live Hetzner
> credentials, so the byte-streaming/metering suites that drove the deleted
> gateway were removed. What remains is the storage-independent accounting and
> billing math, which only needs Postgres.

## What it covers

| Suite | Spec | Guards |
|-------|------|--------|
| `suites/concurrent-capacity.test.ts` | §4.5 | The atomic quota guard in `@medialocker/core.reserveCapacity` (`UPDATE ... WHERE used_bytes + delta <= allocated_bytes`): two concurrent reservations that don't both fit cannot both succeed, and `used_bytes` never exceeds `allocated_bytes`; concurrent overwrites reconcile to the true size, not a double count. |
| `suites/billing-proration.test.ts` | §9.2 | A mid-cycle add-on bills the PRORATED amount (`full * daysRemaining / cycleDays`), strictly less than full; non-prorated control bills full. Runs the real `@medialocker/billing.addCapacity` against real Postgres (Stripe network calls stubbed). |

## Running it

```bash
# 1. Bring up the throwaway stack (non-default host ports, ephemeral volumes):
docker compose -f tests/integration/docker-compose.test.yml up -d

# 2. Run the suites from the repo root (waits for health, applies
#    packages/db/migrations/*.sql in order, seeds per-test fixtures):
pnpm test:integration

# 3. Tear down (removes containers and volumes):
docker compose -f tests/integration/docker-compose.test.yml down -v
```

The global setup (`scripts/setup.ts`) waits for Postgres/Redis health,
provisions the `medialocker_service` / `authenticated` / `anon` roles that the
production migrations GRANT to, then applies the **real, unmodified**
`packages/db/migrations/*.sql` via a runner that mirrors
`packages/db/scripts/migrate.ts`. Each test seeds its **own** isolated
org/capacity/bucket (`scripts/seed.ts`) so suites never collide.

`scripts/setup.ts` can also run standalone (e.g. in a CI step before the test
command):

```bash
pnpm --dir tests/integration exec tsx scripts/setup.ts
```

## Connection settings

Defaults live in `scripts/test-env.ts` and mirror `docker-compose.test.yml`
(host ports `55432` / `56379`). Override any of them in CI via
`TEST_DATABASE_URL`, `TEST_REDIS_URL`, or the granular `TEST_PG_*` / `TEST_REDIS_*`
vars. The `HETZNER_S3_*` config keys are set to dummy placeholders (overridable
via `TEST_HETZNER_S3_*`) purely to satisfy `@medialocker/config`'s schema —
nothing in the harness opens an S3 connection, so no object-storage container
is run.

## How it mirrors production wiring

- Postgres client built with the same `postgres` driver options and **no
  camel-case transform** — matching `packages/db/src`.
- The accounting helpers under test (`@medialocker/core`
  `reserveCapacity`/`releaseCapacity`) and the billing path
  (`@medialocker/billing.addCapacity`) are the exact modules the apps ship,
  aliased to TS source in `vitest.config.ts`.

## CI notes

- Requires a Docker engine on the runner. GitHub Actions: add `postgres` and
  `redis` as services **or** run the compose file in a step before
  `pnpm test:integration`.
- The suite runs single-forked (`pool: forks`, `singleFork: true`) because it
  touches a shared external store; per-test isolated fixtures keep it correct.
