# Environment Variables Reference

Complete list of environment variables for self-hosting MediaLocker.

## Core

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | Yes | `production` | Environment: development, production |
| `LOG_LEVEL` | No | `info` | Logging level: debug, info, warn, error |
| `PUBLIC_BASE_DOMAIN` | Yes | — | Main domain (e.g., `medialocker.io`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | — | OpenTelemetry collector endpoint |

## Database & Auth (Supabase Cloud)

Postgres and Auth are managed by Supabase Cloud. Create a project at supabase.com and copy these values from Project Settings → Database (connection strings) and Project Settings → API Keys (publishable + secret keys). Dashboard session JWTs are verified against the project JWKS (asymmetric ES256) — there is **no shared JWT secret** to copy. See the [Provision Supabase Cloud](/self-hosting/docker-compose#provision-supabase-cloud) runbook.

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | Postgres connection string. App runtime (`api`/`worker`/`mcp`) uses the **transaction pooler (port `6543`)** with `?sslmode=require`; prepared statements are disabled in code for it. **Migrations and `setup-stripe`** must instead use the **session pooler (port `5432`) or a direct connection** because they hold a session-level advisory lock. |
| `SUPABASE_URL` | Yes | — | `https://<project-ref>.supabase.co`. Also the source of the JWKS endpoint used to verify dashboard session JWTs (asymmetric ES256) — **no shared JWT secret is needed**. |
| `SUPABASE_SECRET_KEY` | Yes | — | Secret API key `sb_secret_…` (Project Settings → API Keys → Secret) — **backend/admin only, never expose to the browser**. Replaces the legacy service_role key. |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | — | `https://<project-ref>.supabase.co` — inlined into the `app` frontend at build time |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Yes | — | Publishable API key `sb_publishable_…` (Project Settings → API Keys → Publishable) — inlined into the `app` frontend at build time. Replaces the legacy anon key. |

::: warning Two connection strings
Use the **`6543` transaction pooler** for `DATABASE_URL` in `.env` (app runtime). Run migrations and `setup-stripe` with a one-off **`5432` session pooler / direct** URL — they hold a session-level advisory lock the transaction pooler cannot keep across statements.
:::

## Redis

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_URL` | Yes | — | Redis connection URL |
| `REDIS_PASSWORD` | Yes | — | Password the Redis container runs with (`--requirepass`) |

## Object Storage (Hetzner)

The master Hetzner Object Storage credential is held only by the backend (`api`, `worker`, `mcp`). It is used to provision buckets and issue presigned URLs — it is never exposed to tenants or the browser.

| Variable | Required | Default | Description |
|---|---|---|---|
| `HETZNER_S3_ENDPOINT` | Yes | — | Hetzner Object Storage endpoint |
| `HETZNER_S3_REGION` | Yes | — | Hetzner Object Storage region (run the worker in-region) |
| `HETZNER_S3_ACCESS_KEY` | Yes | — | Master access key (backend only) |
| `HETZNER_S3_SECRET_KEY` | Yes | — | Master secret key (backend only) |

## Stripe

| Variable | Required | Default | Description |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | Yes | — | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Yes | — | Stripe webhook signing secret |
| `STRIPE_PORTAL_CONFIG_ID` | No | — | Stripe customer portal config |

## Internal Auth

| Variable | Required | Default | Description |
|---|---|---|---|
| `INTERNAL_API_SECRET` | Yes | — | Internal service-to-service auth |
| `API_KEY_ENC_KEY` | Yes | — | 32-byte base64 key for API key encryption |
| `WORKER_METRICS_TOKEN` | No | — | Optional bearer token for worker `/metrics` and `/admin/queues` (internal network only) |

## TLS

| Variable | Required | Default | Description |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | No | — | Cloudflare API token for DNS-01 challenge |

## Analytics

| Variable | Required | Default | Description |
|---|---|---|---|
| `PLAUSIBLE_DOMAIN` | No | — | Plausible analytics domain |
| `PLAUSIBLE_SECRET_KEY` | No | — | Plausible secret key base |
| `CLICKHOUSE_PASSWORD` | No | — | Password for the Plausible ClickHouse database |

## Example .env

```bash
# Core
NODE_ENV=production
LOG_LEVEL=info
PUBLIC_BASE_DOMAIN=medialocker.io

# Postgres + Auth — Supabase Cloud (managed)
# App runtime uses the TRANSACTION pooler (6543); keep ?sslmode=require.
DATABASE_URL=postgresql://postgres.<project-ref>:<db-password>@aws-0-<region>.pooler.supabase.com:6543/postgres?sslmode=require
# NOTE: run migrations + setup-stripe with the SESSION pooler (5432) or a
# direct connection instead — they hold a session-level advisory lock.
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...               # backend/admin only
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...

# Redis
REDIS_URL=redis://redis:6379
REDIS_PASSWORD=generate-a-strong-password

# Object Storage (Hetzner) — master credential, backend only
HETZNER_S3_ENDPOINT=https://fsn1.your-objectstorage.com
HETZNER_S3_REGION=fsn1
HETZNER_S3_ACCESS_KEY=
HETZNER_S3_SECRET_KEY=

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PORTAL_CONFIG_ID=bpc_...

# Internal
INTERNAL_API_SECRET=generate-a-random-64-char-string
API_KEY_ENC_KEY=$(openssl rand -base64 32)
WORKER_METRICS_TOKEN=

# TLS
CLOUDFLARE_API_TOKEN=dns-token

# Analytics
PLAUSIBLE_DOMAIN=medialocker.io
PLAUSIBLE_SECRET_KEY=
CLICKHOUSE_PASSWORD=
```
