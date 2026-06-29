# Docker Compose Setup

## Directory Structure

```
infra/
├── docker-compose.yml
└── caddy/
    └── Caddyfile
```

Postgres and Auth run on Supabase Cloud, so there is no `postgres` or `supabase/` service in the compose stack. Object storage is external (Hetzner Object Storage), so there is no storage service either.

## Provision Supabase Cloud

Do this **before** building or starting the stack. Postgres and Auth are managed by Supabase Cloud — the compose services only connect to them.

### 1. Create a project

Create a project at [supabase.com](https://supabase.com). Pick a region close to your host and your Hetzner region to keep latency low.

### 2. Copy keys and connection strings

From the Supabase dashboard, collect:

| Value | Where |
|---|---|
| Publishable key (`sb_publishable_…`) | Project Settings → API Keys → Publishable (client-side; inlined into the frontend) |
| Secret key (`sb_secret_…`) | Project Settings → API Keys → Secret (backend/admin-only — never expose to the browser) |
| Transaction pooler URL (port `6543`) | Project Settings → Database → Connection string → Transaction pooler |
| Session pooler URL (port `5432`) | Project Settings → Database → Connection string → Session pooler (or the direct connection) |

::: tip Two connection strings, two jobs
- **App runtime** (`api`, `worker`, `mcp`) uses the **transaction pooler on port `6543`** with `?sslmode=require`. Prepared statements are disabled in code for this pooler. This is your `DATABASE_URL`.
- **The migration runner and `setup-stripe`** must use the **session pooler on port `5432`** (or a direct connection). They hold a **session-level advisory lock**, which the transaction pooler cannot maintain across statements.
:::

::: tip No JWT secret needed
Dashboard session tokens are signed with the project's **asymmetric (ES256) signing keys** and verified against its JWKS endpoint (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`) — so there is no shared HS256 JWT secret to copy or rotate. The legacy `anon`/`service_role` keys are likewise replaced by the publishable/secret keys above (Supabase removes the legacy keys in late 2026).
:::

### 3. Run migrations

Run migrations against the **session pooler / direct** URL (not the `6543` runtime URL):

```bash
DATABASE_URL=postgresql://postgres.<project-ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require \
  pnpm --filter @medialocker/db migrate
```

The app connects as the Cloud `postgres` role, which owns the schema and therefore bypasses RLS — no separate `medialocker_service` role is created on Cloud.

Then configure Stripe products/prices (also a session/direct connection):

```bash
DATABASE_URL=<session-or-direct-url> pnpm stripe:setup
```

### 4. Configure Auth

In the Supabase dashboard → Authentication:

- **Site URL**: `https://app.<domain>`
- **Redirect URLs**: add both
  - `https://app.<domain>/auth/callback`
  - `https://<domain>/auth/callback`
- **Signup policy**: set according to whether you allow open signups.
- **Email confirmation**: enable to require confirmed email before sign-in.
- **OAuth providers**: register **Google** and **GitHub** if you offer social sign-in. Add their client IDs/secrets and authorize the redirect URLs above.

### 5. Set runtime env

Put the collected values into `.env` (see [Environment Variables](/self-hosting/environment) for the full reference):

```bash
DATABASE_URL=postgresql://postgres.<project-ref>:<db-password>@aws-0-<region>.pooler.supabase.com:6543/postgres?sslmode=require
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...               # backend/admin only
# Inlined into the frontends at build time
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

::: warning Build/config require Supabase values
`docker compose config` and `docker compose build` now require `DATABASE_URL`, `SUPABASE_URL`, and `NEXT_PUBLIC_SUPABASE_URL` to be set. The `NEXT_PUBLIC_*` values are inlined into the `app` bundle at build time — rebuild that image if they change.
:::

## Main docker-compose.yml

The main compose file defines the self-hosted services on a private network with named volumes.

### Key Configuration

```yaml
networks:
  medialocker:
    driver: bridge

volumes:
  redis_data:
  caddy_data:
  caddy_config:
```

### Service Configuration

Each service is configured with:
- `restart: unless-stopped`
- Resource limits (`deploy.resources`)
- Health checks
- Internal network only (except Caddy)

## Starting Services

```bash
# Build and start all services
docker compose -f infra/docker-compose.yml up -d --build

# View logs
docker compose -f infra/docker-compose.yml logs -f

# Stop all services
docker compose -f infra/docker-compose.yml down

# Stop and remove volumes (destructive!)
docker compose -f infra/docker-compose.yml down -v
```

## Service Health Checks

Redis has a health check to ensure proper startup order:

```yaml
redis:
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
    interval: 5s
    timeout: 5s
    retries: 5
```

The application services depend on the external Supabase Cloud Postgres and Auth, which are reached over the network rather than gated by a local `depends_on`.

## Dependency Order

Startup dependencies:
1. `redis` (infrastructure)
2. `api`, `worker`, `mcp` (depend on `redis`; connect to Supabase Cloud Postgres/Auth and external Hetzner Object Storage)
3. `app`, `docs` (static/runtime apps)
4. `plausible`, `plausible-db` (analytics)
5. `caddy` (depends on all public services)

Docker Compose `depends_on` with health checks ensures correct ordering for the self-hosted services.

## Resource Limits

```yaml
services:
  api:
    deploy:
      resources:
        limits:
          cpus: "1"
          memory: "512M"
        reservations:
          cpus: "0.5"
          memory: "256M"
```

## Environment Variables

All services read from `.env`. See [Environment Variables](/self-hosting/environment) for the complete reference.
