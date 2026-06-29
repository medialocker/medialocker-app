# Upgrade Guide

Step-by-step runbook for upgrading a self-hosted MediaLocker instance.

Postgres and Auth are managed by Supabase Cloud — Supabase upgrades the database engine and GoTrue for you, so this runbook only covers the self-hosted services and applying schema migrations to the Cloud database.

## Pre-Upgrade Checklist

- [ ] Read the release notes for breaking changes
- [ ] Confirm a recent Supabase Cloud backup / PITR window is available before migrating
- [ ] Backup environment file (`.env`)
- [ ] Note current version: `git describe --tags`
- [ ] Schedule maintenance window
- [ ] Notify users if downtime expected

## Standard Upgrade

### 1. Pull Latest Changes

```bash
cd /opt/medialocker
git fetch --tags
git checkout v1.2.0  # or latest tag
```

### 2. Backup

Postgres backups are managed by Supabase Cloud — confirm a recent automated backup exists (or take a manual snapshot / note your PITR window) from the Supabase dashboard before migrating. Object storage lives in Hetzner Object Storage and is not part of the upgrade — its durability is handled by the provider.

### 3. Review Environment Changes

Compare `.env.example` with your `.env` for new required variables:

```bash
diff .env.example .env
```

Add any new required variables to your `.env`.

### 4. Run Database Migrations

Run migrations against the Supabase Cloud database using a **session pooler (port `5432`) or direct** connection — the migration runner holds a session-level advisory lock, so it cannot use the `6543` transaction pooler:

```bash
DATABASE_URL=<session-or-direct-url> pnpm --filter @medialocker/db migrate
```

::: warning
Always test migrations on a staging Supabase project first. Some migrations can be slow on large datasets.
:::

### 5. Rebuild and Restart

```bash
docker compose -f infra/docker-compose.yml down
docker compose -f infra/docker-compose.yml build --no-cache
docker compose -f infra/docker-compose.yml up -d
```

### 6. Verify

```bash
# Check all services are healthy
docker compose -f infra/docker-compose.yml ps

# Check logs for errors
docker compose -f infra/docker-compose.yml logs --tail=50

# Verify API responds
curl https://api.medialocker.io/health
```

## Zero-Downtime Upgrade

For minimal service interruption:

### 1. Scale API Workers

```bash
docker compose -f infra/docker-compose.yml up -d --scale api=2
```

### 2. Rolling Restart

```bash
# Restart services one at a time
docker compose -f infra/docker-compose.yml up -d --no-deps api
docker compose -f infra/docker-compose.yml up -d --no-deps worker
docker compose -f infra/docker-compose.yml up -d --no-deps mcp
docker compose -f infra/docker-compose.yml up -d --no-deps app
```

Caddy will automatically route traffic to healthy instances.

### 3. Scale Back

```bash
docker compose -f infra/docker-compose.yml up -d --scale api=1
```

## Rollback

If the upgrade causes issues:

### 1. Checkout Previous Version

```bash
git checkout v1.1.0
```

### 2. Rebuild with Previous Version

```bash
docker compose -f infra/docker-compose.yml down
docker compose -f infra/docker-compose.yml build
docker compose -f infra/docker-compose.yml up -d
```

### 3. Restore Database (if needed)

If a migration must be rolled back, restore the database from Supabase Cloud: use the **Supabase dashboard → Database → Backups** (or point-in-time recovery) to restore to a point just before the migration. There is no local `pg_restore` step — the database is managed.

## Version Compatibility Matrix

Postgres is provided by Supabase Cloud (Postgres 15+); Supabase manages the engine version.

| MediaLocker | Postgres (Supabase Cloud) | Redis | Node.js |
|---|---|---|---|
| 1.0.x | Managed | 7.x | 22 |
| 1.1.x | Managed | 7.x | 22 |
| 1.2.x | Managed | 7.x | 22 |

## Troubleshooting Upgrades

### Migration Failures

Migrations run against the Supabase Cloud database over a session/direct connection. If one fails, inspect the migration state using the Supabase dashboard SQL editor (or `psql` with your session/direct `DATABASE_URL`):

```sql
SELECT * FROM _prisma_migrations ORDER BY finished_at DESC;
```

A failed migration usually leaves a session-level advisory lock held only for the duration of the run — re-run the migrate command (against the `5432`/direct URL) once the underlying issue is fixed.

### Container Won't Start

```bash
# Check logs
docker compose -f infra/docker-compose.yml logs api

# Check environment
docker compose -f infra/docker-compose.yml run --rm api env | sort
```

### Certificate Issues After Upgrade

```bash
# Force Caddy to renew
docker exec caddy caddy reload
```

## Automated Upgrades

For CI/CD-based upgrades:

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    tags: ["v*"]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run migrations
        run: |
          ssh server "cd /opt/medialocker && git pull && \
            DATABASE_URL=$SUPABASE_SESSION_DATABASE_URL \
            pnpm --filter @medialocker/db migrate"
      - name: Rebuild containers
        run: |
          ssh server "cd /opt/medialocker && docker compose -f infra/docker-compose.yml up -d --build"
      - name: Health check
        run: |
          sleep 30
          curl -f https://api.medialocker.io/health
```
