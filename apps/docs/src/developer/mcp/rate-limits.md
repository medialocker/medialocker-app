# MCP Rate Limits

The MCP gateway enforces a per-organization **token bucket**, independent of the
[REST API limits](/developer/rate-limits):

| Window | Limit |
|---|---|
| Per minute | 120 requests |
| Per day | 50,000 requests |
| Burst | 120 |

Limits are keyed per organization (resolved from your API key), so all clients
sharing a credential draw from the same bucket. When a tenant exceeds the limit,
the call is rejected at the **rate-limit** stage of the gateway — before the
allowlist, audit, or tool handler runs — and the client receives a JSON-RPC error.

The limiter is backed by Redis. In production the server **refuses to start**
without Redis; an in-memory fallback exists only for local development and must be
explicitly enabled with `MCP_ALLOW_MEMORY_RATE_LIMITER=true`.

::: tip Design agents to back off
Agents that loop over many objects should pace their calls and handle rate-limit
errors with a short backoff. Prefer `search_media` and `list_objects` with
pagination over issuing one tool call per object.
:::
