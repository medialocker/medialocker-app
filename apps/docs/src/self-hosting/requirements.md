# System Requirements

## Minimum Requirements

| Resource | Minimum | Recommended |
|---|---|---|
| **CPU** | 2 cores | 4+ cores |
| **RAM** | 4 GB | 8+ GB |
| **Disk** | 20 GB | 50 GB |
| **OS** | Linux (amd64) | Ubuntu 22.04+ |
| **Docker** | 24.0+ | 26.0+ |
| **Docker Compose** | v2.20+ | Latest |

The host only runs the application services, Redis, Caddy, and analytics — Postgres is managed by Supabase Cloud, so the host no longer needs headroom for the database.

## Prerequisites

Before deploying, provision these external services:

- **A Supabase Cloud project** — provides managed Postgres and Auth (GoTrue). You will need both connection strings (transaction pooler on `6543` and session pooler on `5432`) and the project's publishable + secret API keys (Project Settings → API Keys). Dashboard sessions are verified against the project JWKS (asymmetric ES256), so there is no shared JWT secret to manage. See [Docker Compose Setup](/self-hosting/docker-compose) for the provisioning runbook.
- **A Hetzner Object Storage project** — stores all media objects (see [Storage Backend](/self-hosting/storage)).
- **A Cloudflare-managed DNS zone** (or another supported DNS provider) — for wildcard DNS-01 TLS (see [Wildcard TLS](/self-hosting/wildcard-tls)).

## Storage Planning

Media objects are stored in Hetzner Object Storage, not on the host. Capacity and durability scale with your Hetzner project — there is no local object-storage disk to provision. The host disk only needs room for the OS, container images, Redis persistence, and logs.

| Usage Level | Users | Media Volume (Hetzner) |
|---|---|---|
| Small | 1–10 | < 500 GB |
| Medium | 10–50 | 1–5 TB |
| Large | 50–200 | 10–50 TB |

## Network

All self-hosted services run on a private Docker network (`medialocker`). Only Caddy exposes ports 80 and 443. Outbound connectivity to Supabase Cloud (Postgres pooler + Auth API) and Hetzner Object Storage is required.

### Firewall Rules

Allow inbound:
- 80/tcp — HTTP → HTTPS redirect
- 443/tcp — HTTPS (TLS)

Allow internal (Docker network):
- All ports between medialocker-network services

Allow outbound:
- 443/tcp — Supabase Auth API + Hetzner Object Storage
- 5432/tcp and 6543/tcp — Supabase Cloud Postgres poolers

### Ports Summary

| Service | Port | Public? |
|---|---|---|
| Caddy | 80, 443 | Yes |
| Redis | 6379 | No |

## DNS Configuration

Wildcard DNS covers the service subdomains (`app`, `api`, `mcp`, `docs`, ...):

```
medialocker.io      → <server-ip>
*.medialocker.io    → <server-ip>
```

Set up these A/CNAME records:
- `medialocker.io` → your server IP
- `*.medialocker.io` → your server IP

## Docker Volumes

The following named volumes are created:

| Volume | Purpose | Persistence |
|---|---|---|
| `redis_data` | Redis AOF/RDB | Recommended |
| `caddy_data` | TLS certificates | Required |
| `caddy_config` | Caddy state | Required |
