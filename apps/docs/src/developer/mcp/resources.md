# Resources

Alongside tools, the MCP server exposes read-only **resources** — addressable
context an agent can fetch without invoking a tool. Each resource is identified by a
`medialocker://` URI and returns metadata only (never object bytes).

| Resource | URI | Returns |
|---|---|---|
| Bucket summary | `medialocker://buckets/{id}` | Bucket metadata and usage statistics |
| Media info | `medialocker://media/{id}` | Media/object metadata (no binary content) |
| Usage report | `medialocker://usage` | Current organization usage summary |

Resources are scoped to the authenticated organization, just like tools. To read an
object's actual bytes, use [`get_object_url`](/developer/mcp/tools) to obtain a
presigned download URL.

```ts
// List available resources
const { resources } = await client.listResources();

// Read a specific bucket's summary
const bucket = await client.readResource({
  uri: "medialocker://buckets/b3f1e2c4-…",
});
```
