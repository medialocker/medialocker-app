# Connecting

The MCP server speaks the Model Context Protocol over a Streamable-HTTP transport
at `https://mcp.medialocker.io/mcp`. Any MCP-compatible client can connect by
pointing at that URL and supplying an API key secret as a bearer token.

## Client configuration

Most clients accept an HTTP MCP server with a URL and headers:

```json
{
  "mcpServers": {
    "medialocker": {
      "url": "https://mcp.medialocker.io/mcp",
      "headers": {
        "Authorization": "Bearer <secret-access-key>"
      }
    }
  }
}
```

The bearer value is the **Secret Access Key** of a MediaLocker API key — the same
credential used for the REST API (see [Authentication](/developer/mcp/authentication)).

## Programmatic clients

Using the official MCP SDK, connect with the Streamable-HTTP transport and pass the
bearer header:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("https://mcp.medialocker.io/mcp"),
  { requestInit: { headers: { Authorization: "Bearer <secret-access-key>" } } },
);

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);

// Discover available tools
const { tools } = await client.listTools();

// Call a tool
const result = await client.callTool({
  name: "search_media",
  arguments: { q: "sunset", kind: "image", limit: 20 },
});
```

::: tip Tool discovery
Call `tools/list` (`client.listTools()`) after connecting to enumerate exactly the
tools your credential is allowed to use. The set reflects your key's scopes and any
per-credential [allowlist](/developer/mcp/authentication#tool-allowlisting), so it
may be narrower than the full [catalog](/developer/mcp/tools).
:::

## Sessions

The transport is session-aware: a connection establishes a session that carries
your authenticated tenant context across subsequent JSON-RPC calls. Reads and
mutations share the same `POST /mcp` endpoint.
