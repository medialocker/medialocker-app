# Self-Hosting Guide

Deploy MediaLocker on your own infrastructure with Docker Compose. This guide covers everything from requirements to production scaling.

MediaLocker is a hybrid deployment: you self-host the application services, Redis, Caddy, and analytics with Docker Compose, while **Postgres and Auth run on Supabase Cloud (managed)** and object storage lives in **Hetzner Object Storage**. There is no database, GoTrue, or PostgREST container to operate — the stack connects to your Supabase project over the network.

## Architecture Overview

```
                        ┌──────────────────────────────┐
                        │     Caddy (Reverse Proxy)     │
                        │     Wildcard TLS (DNS-01)     │
                        └──────────┬───────────────────┘
                                   │
                  ┌────────────────┼────────────────┐
                  ▼                ▼                ▼
                app.*            api.*            mcp.*
               (app)            (api)            (mcp)
                  │                │                │
                  └────────────────┼────────────────┘
                                   │
                                   ▼
                                 redis  ◄── self-hosted (Docker)

    Postgres + Auth are Supabase Cloud (managed) — the api/worker/mcp
    services connect over DATABASE_URL + the Supabase Auth API.

    Object storage is external (Hetzner Object Storage);
    the api/worker/mcp services hold the master credential
    and issue presigned URLs — no local storage container.
```

## Components

| Component | Where | Description |
|---|---|---|
| **Caddy** | Self-hosted | Reverse proxy, wildcard TLS via DNS-01 |
| **app** | Self-hosted | Next.js dashboard (app.medialocker.io) |
| **api** | Self-hosted | Backend API (api.medialocker.io) |
| **mcp** | Self-hosted | MCP server (mcp.medialocker.io) |
| **worker** | Self-hosted | Background job processor (derivatives, runs in-region) |
| **redis** | Self-hosted | Redis with AOF persistence (port 6379, internal) |
| **plausible** | Self-hosted | Privacy-first analytics (+ ClickHouse) |
| **docs** | Self-hosted | VitePress documentation site |
| **Postgres** | Supabase Cloud | Managed Postgres — connect via `DATABASE_URL` |
| **Auth** | Supabase Cloud | Managed GoTrue — Supabase Auth API |
| Object storage | Hetzner | External Hetzner Object Storage — no local container; the backend holds the master credential and issues presigned URLs |

## Subdomains

| Subdomain | Service |
|---|---|
| `app.medialocker.io` | Dashboard |
| `api.medialocker.io` | REST API |
| `mcp.medialocker.io` | MCP server |
| `docs.medialocker.io` | Documentation |
| `plausible.medialocker.io` | Analytics dashboard |

## Quick Start

```bash
# Clone the repository
git clone https://github.com/medialocker/medialocker-app.git
cd medialocker-app

# Copy environment template
cp .env.example .env
# Edit .env with your values — including the Supabase Cloud
# connection strings and keys (see Docker Compose Setup)

# Run migrations against the Supabase Cloud DB
# (use the SESSION pooler / port 5432 or a direct connection)
DATABASE_URL=<session-or-direct-url> pnpm --filter @medialocker/db migrate

# Setup Stripe (also needs a session/direct connection)
DATABASE_URL=<session-or-direct-url> pnpm stripe:setup

# Start the self-hosted services
docker compose -f infra/docker-compose.yml up -d
```

## Prerequisites

See the [Requirements](/self-hosting/requirements) page for detailed system requirements before starting. You will need a **Supabase Cloud project** in addition to your host.

## Production Readiness Checklist

Before going to production, verify each item:

- [ ] Supabase Cloud project provisioned, migrations applied, and Auth configured (see [Docker Compose Setup](/self-hosting/docker-compose))
- [ ] All required environment variables configured (see [Environment Variables](/self-hosting/environment))
- [ ] Wildcard TLS certificates obtained and auto-renewal confirmed (see [Wildcard TLS](/self-hosting/wildcard-tls))
- [ ] Supabase Cloud backups/PITR retention confirmed and Redis backups scheduled (see [Backups](/self-hosting/backups))
- [ ] Hetzner Object Storage project access verified (master credential set, durability relied on)
- [ ] Resource limits set on all Docker containers
- [ ] Firewall rules applied — only ports 80 and 443 exposed
- [ ] Health checks passing for all services: `docker compose -f infra/docker-compose.yml ps`
- [ ] Log aggregation configured (see [Scaling](/self-hosting/scaling))
- [ ] Upgrade procedure tested on staging (see [Upgrade Guide](/self-hosting/upgrade))
- [ ] Monitoring and alerting configured (Prometheus + Grafana recommended)
- [ ] Stripe integration verified with test mode before switching to live keys
