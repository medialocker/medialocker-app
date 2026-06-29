# MCP Server

The CLI doubles as a **local [MCP](https://modelcontextprotocol.io) server**,
exposing your media library to AI agents (Claude Desktop, Cursor, and other
MCP clients) over stdio — using the API key in your config.

## Run the server

```bash
medialocker mcp serve
```

This speaks the MCP protocol on stdio, so it's launched by an MCP client rather
than run by hand. stdout is reserved for the protocol; logs go to stderr.

## Install into a client

```bash
medialocker mcp install --client claude          # print a config block
medialocker mcp install --client claude --write  # merge into Claude Desktop's config
medialocker mcp install --client cursor          # print a Cursor config block
```

`install` emits (or merges) a `medialocker` MCP server entry that runs
`medialocker mcp serve` with your resolved URL and API key.

## Tools

The local server exposes these tools, each scoped by your API key's
[permissions](/developer/authentication#scopes):

| Tool | Does |
|---|---|
| `list_buckets` | List buckets |
| `create_bucket` | Create a bucket |
| `list_media` | List/filter media objects |
| `search_media` | Full-text + facet search |
| `get_object` | Object metadata by id |
| `get_object_url` | A presigned download URL |
| `upload_object` | Upload a local file to a bucket |
| `get_usage` | Storage and request usage snapshot |

## Local CLI server vs. the hosted MCP

MediaLocker also runs a **hosted** MCP server at `https://mcp.medialocker.io` over
Streamable HTTP, with a richer tool catalog and a multi-tenant gateway. Pick based
on how the agent connects:

| | Local (`medialocker mcp serve`) | Hosted ([mcp.medialocker.io](/developer/mcp/)) |
|---|---|---|
| Transport | stdio (runs on your machine) | Streamable HTTP (remote) |
| Setup | `mcp install` | Point a client at the URL with a bearer token |
| Tools | The core set above | The [full catalog](/developer/mcp/tools) |
| Best for | Local/desktop agents, self-hosted instances | Always-on, multi-client access |

::: tip
Use the local server when an agent runs on the same machine as the CLI; use the
[hosted MCP server](/developer/mcp/) for remote or always-on access. Both honor the
same API keys and scopes.
:::

## See also

- [MCP Server](/developer/mcp/) — the hosted Streamable-HTTP server
- [Command Reference](/developer/cli/commands) — the rest of the CLI
