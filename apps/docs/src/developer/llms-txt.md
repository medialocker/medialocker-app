# llms.txt

MediaLocker publishes [`llms.txt`](https://llmstxt.org/) discovery documents —
plain-text, Markdown-formatted summaries that let AI assistants and coding agents
learn how to connect and what's available without crawling the full docs. There are
two, and they're complementary:

- **Docs site (product-wide):** [`/llms.txt`](https://docs.medialocker.io/llms.txt) is
  an index across all three surfaces — REST API, MCP server, and CLI — with
  [`/llms-full.txt`](https://docs.medialocker.io/llms-full.txt) inlining the full
  instructions. Start here for "how do I use MediaLocker programmatically?"
- **MCP server (live, version-pinned):** the running MCP server serves its own
  `llms.txt` describing exactly the deployed tool catalog. Use this when you need the
  authoritative, up-to-the-deploy MCP surface.

The rest of this page covers the **MCP server** document.

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
This `llms.txt` (served by the MCP server) documents the **MCP surface only** —
connection, auth, tools, rate limits, error codes. For a product-wide index across the
REST API, MCP, and CLI, use the docs-site
[`/llms.txt`](https://docs.medialocker.io/llms.txt) and
[`/llms-full.txt`](https://docs.medialocker.io/llms-full.txt). For machine-readable REST
details specifically, use the OpenAPI spec at
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
