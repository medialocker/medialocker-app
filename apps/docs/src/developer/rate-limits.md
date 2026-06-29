# Rate Limits

MediaLocker rate-limits both the REST API and the MCP server to protect the
service and keep usage fair across tenants.

## REST API

The API allows **300 requests per minute**, keyed per organization (or by client
IP for unauthenticated requests). The limit is enforced with a Redis-backed
sliding window that falls back to an in-memory limiter if Redis is unavailable.

When you exceed the limit the API responds with `429 Too Many Requests`:

```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "Rate limit exceeded, retry after 12 seconds"
}
```

::: tip Back off on 429
On a `429`, pause and retry after a short delay. Spread bulk operations over time
rather than issuing them in a tight loop, and prefer batch endpoints where available.
:::

::: warning Edge limit in front of the API
When deployed behind Caddy, a coarser per-IP edge rate limit (≈600 req/min) sits
in front of the application limiter as a DDoS/abuse guard. Your effective ceiling
is the stricter of the two.
:::

## MCP server

The MCP server enforces a per-organization **token bucket**:

| Window | Limit |
|---|---|
| Per minute | 120 requests |
| Per day | 50,000 requests |
| Burst | 120 |

The MCP limiter is Redis-backed; the server refuses to start without Redis unless
explicitly forced into an in-memory fallback (`MCP_ALLOW_MEMORY_RATE_LIMITER=true`),
which is intended only for local development. When a tenant exceeds the limit, the
call is rejected at the gateway with a JSON-RPC error before the tool runs.

See [MCP → Rate Limits](/developer/mcp/rate-limits) for details specific to the
MCP gateway.
