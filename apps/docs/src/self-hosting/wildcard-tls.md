# Wildcard TLS with Caddy

MediaLocker uses Caddy with DNS-01 challenge to obtain a wildcard TLS certificate for `*.medialocker.io`.

## Why Wildcard TLS?

A single wildcard certificate covers all service subdomains (`app`, `api`, `mcp`, `docs`, ...) without provisioning an individual certificate per host. Object storage is served by Hetzner Object Storage over its own domain via presigned URLs, so no storage subdomains are proxied here.

## Caddy Build

Use a custom Caddy build with the DNS provider module:

```dockerfile
FROM caddy:2-builder AS builder

RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare

FROM caddy:2

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
```

## DNS-01 Challenge

Caddy uses the DNS-01 ACME challenge, which:
1. Requests a certificate from Let's Encrypt (or ZeroSSL).
2. Receives a DNS TXT record to create.
3. Creates the TXT record via Cloudflare API.
4. Let's Encrypt verifies the record and issues the certificate.

No HTTP challenge needed, no open port 80 required.

## Cloudflare Setup

1. Get a Cloudflare API token with DNS edit permissions.
2. Set `CLOUDFLARE_API_TOKEN` in your `.env` file.
3. Caddy uses the token automatically.

For other DNS providers, swap `caddy-dns/cloudflare` with the appropriate module:
- `caddy-dns/route53` for AWS Route 53
- `caddy-dns/digitalocean` for DigitalOcean
- `caddy-dns/namecheap` for Namecheap
- `caddy-dns/godaddy` for GoDaddy

## Caddyfile Configuration

```caddyfile
{
    email admin@medialocker.io
    acme_ca https://acme-v02.api.letsencrypt.org/directory
}

*.medialocker.io {
    tls {
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
    }
}

# The root domain (medialocker.io) is NOT proxied by this Caddy — only the
# app/api/mcp/docs subdomains are. Route the root domain's DNS wherever you
# choose (or leave it unused).

app.medialocker.io {
    reverse_proxy app:3000
}
```

## Certificate Storage

Caddy stores certificates in a persistent Docker volume:
- `caddy_data` — TLS certificates and OCSP staples
- `caddy_config` — Caddy state

These volumes should be backed up (see [Backups](/self-hosting/backups)).

## Renewal

Caddy automatically renews certificates before expiry. No manual intervention needed.

To force renewal:
```bash
docker exec caddy caddy reload
```

## Security Headers

Caddy can add security headers via the Caddyfile:

```caddyfile
app.medialocker.io {
    header {
        Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
        Content-Security-Policy "default-src 'self'; script-src 'self' https://plausible.io; style-src 'self' 'unsafe-inline'"
        X-Frame-Options "DENY"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
    reverse_proxy app:3000
}
```
