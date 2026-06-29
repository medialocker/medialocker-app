# llms.txt

The MediaLocker **MCP server** publishes an [`llms.txt`](https://llmstxt.org/)
discovery document — a plain-text, Markdown-formatted summary that lets AI
assistants and coding agents learn how to connect and what tools are available
without reading the full docs.

## Where it's served

The document is served **unauthenticated** by the MCP server at three paths:

| URL | |
|---|---|
| `https://mcp.medialocker.io/llms.txt` | Primary |
| `https://mcp.medialocker.io/.well-known/llms.txt` | Well-known location |
| `https://mcp.medialocker.io/mcp/llms.txt` | Under the MCP path |

```bash
curl https://mcp.medialocker.io/llms.txt
```

::: info Scope
`llms.txt` is published by the **MCP server only** — it documents the MCP surface
(connection, auth, tools, rate limits, error codes). The REST API does not serve an
`llms.txt`; for machine-readable REST details use the OpenAPI spec at
`https://api.medialocker.io/api/openapi.json`.
:::

## What it contains

The document is a human- and machine-readable Markdown summary covering:

- **Server URL & transport** — `https://mcp.medialocker.io/mcp`, Streamable HTTP with `Mcp-Session-Id` session management.
- **Authentication** — bearer API keys (and dashboard JWTs), the per-tenant scope/allowlist model, and how to create a key.
- **Available tools** — grouped by area (search, buckets, objects, tags, sets, usage), including which require `write`/`delete`/`admin`.
- **Destructive tools** — the firewall-gated `delete_object`, `delete_bucket`, and `purge`.
- **Rate limits** — 120 requests/minute (burst 120), 50,000/day per tenant.
- **JSON-RPC error codes** and short request examples.

It is versioned with the MCP server release (a `Server version:` line at the top),
so it stays in step with the deployed tool catalog. For the full reference, see the
[MCP Server](/developer/mcp/) section.
