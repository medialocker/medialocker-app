# MCP Server

The MediaLocker **MCP (Model Context Protocol) server** lets AI agents and
MCP-compatible clients work with your media — search and list objects, generate
presigned URLs, manage tags and sets, and read usage — using the same
organization-scoped credentials as the REST API.

- **Base URL:** `https://mcp.medialocker.io`
- **Endpoint:** `/mcp` (Streamable HTTP transport, JSON-RPC, session-aware)

## How it's built

The server is a Fastify application wrapping the MCP SDK. Every request flows
through a multi-tenant gateway before a tool runs:

```
auth → request-scope → rate-limit → allowlist → audit → transport → tool
```

| Stage | Responsibility |
|---|---|
| **auth** | Resolve the bearer token to an organization + scopes (see [Authentication](/developer/mcp/authentication)) |
| **request-scope** | Bind the resolved tenant to the request |
| **rate-limit** | Per-tenant token bucket (see [Rate Limits](/developer/mcp/rate-limits)) |
| **allowlist** | Enforce the per-credential set of permitted tools |
| **audit** | Record tool invocations |
| **transport** | Streamable-HTTP JSON-RPC dispatch into the tool registry |

On top of the gateway, **destructive tools** (`delete_object`, `delete_bucket`,
`purge`) pass through an additional tool-use firewall — policy checks, argument
validation, and audit — before their handler executes.

## Next steps

- [Connecting](/developer/mcp/connecting) — point a client at the server
- [Authentication](/developer/mcp/authentication) — tokens, scopes, and allowlisting
- [Tools](/developer/mcp/tools) — the full tool catalog
- [Resources](/developer/mcp/resources) — read-only context URIs
- [Rate Limits](/developer/mcp/rate-limits) — per-tenant limits
