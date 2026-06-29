import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MCP_VERSION } from "./version.js";

const LLMS_TXT_CONTENT = `# MediaLocker MCP Server

> Server version: ${MCP_VERSION}

## Overview
The MediaLocker MCP server provides tools for managing S3-compatible media storage through the Model Context Protocol. It enables AI assistants to search, browse, upload, and manage media assets within your MediaLocker organization.

## Server URL
https://mcp.medialocker.io/mcp

## Transport
Streamable HTTP (POST /mcp) with session management via the \`Mcp-Session-Id\` header. Terminate a session with DELETE /mcp.

## Authentication
All /mcp requests require a Bearer token in the Authorization header. The multi-tenant gateway resolves your MediaLocker organization (tenant) from the token:
- **API keys**: Created via the MediaLocker dashboard. The bearer token maps to an org, its scopes (read/write/delete/admin), and an optional bucket restriction.
- **User tokens**: Supabase JWT from MediaLocker web/app login (org resolved from your membership).

Each tenant is subject to a per-tenant token-bucket rate limit and a per-tenant tool allowlist (your scopes determine which tools you may call). Every request is recorded in the audit log.

### Creating an API Key
1. Log in to app.medialocker.io
2. Navigate to Settings > API Keys
3. Click "Create API Key" — set scopes (read/write/delete/admin) and optional bucket restriction
4. Copy the generated secret — it will not be shown again

## Available Tools

### Search & Discovery
- **search_media** — Full-text search with filters (kind, tags, categories, size, date range)
- **list_objects** — List objects in a bucket with pagination
- **get_object_metadata** — Get object details (size, type, dimensions)

### Buckets
- **list_buckets** — List all buckets in the organization
- **get_bucket_info** — Get bucket details and usage statistics
- **create_bucket** — Create a new S3 bucket (requires write scope)

### API Keys
- **create_api_key** — Create a new API key with scopes and optional bucket restriction (requires admin scope)

### Objects
- **get_object_url** — Generate a presigned download URL (time-limited)
- **upload_object** — Generate presigned upload instructions
- **delete_object** — Delete an object (DESTRUCTIVE — firewall-gated; requires delete scope)

### Tags & Categories
- **manage_tags** — Create, list, or assign tags to objects
- **manage_categories** — Create, list, or assign categories to objects

### Sets (Variant Groups)
- **create_set** — Create a set for grouping variant renditions
- **add_variant** — Add an object to a set with aspect ratio/size
- **list_sets** — List all sets in the organization
- **generate_variants** — Trigger variant generation for set items

### Usage & Billing
- **get_usage** — Get current storage usage, egress stats
- **get_billing_info** — Get current plan, add-ons, costs
- **manage_capacity** — Add capacity, configure auto-capacity

## Destructive Tools (Firewall-Gated)
These tools destroy data and pass through the tool-use firewall (policy enforcement + argument validation + audit) on top of the per-tenant allowlist and scope checks:
- **delete_object** — Soft-deletes an object
- **delete_bucket** — Deletes a bucket (must be empty)
- **purge** — Permanently deletes soft-deleted objects (requires confirm='DELETE')

A credential must carry the delete (or admin) scope for the allowlist to expose these tools. Human approval can be enabled per deployment; it is disabled by default in v1 (an approval-required policy decision fails closed).

## Rate Limits
Per-tenant token bucket: 120 requests/minute (burst 120), 50,000 requests/day. Enforced at the gateway edge.

## Error Codes
| Code | Meaning |
|------|---------|
| -32600 | Invalid Request |
| -32601 | Method/Tool not found |
| -32602 | Invalid params |
| -32000 | Tool execution error |
| -32001 | Authentication required/failed (Unauthorized) |
| -32002 | Rate limit exceeded |
| -32003 | Tool not accessible to tenant (allowlist / firewall block) |

## Examples

### Initialize connection
\`\`\`json
{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "my-client", "version": "1.0.0"}}}
\`\`\`

### Search media
\`\`\`json
{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "search_media", "arguments": {"q": "sunset", "kind": "video", "limit": 10}}}
\`\`\`

### Upload object
\`\`\`json
{"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "upload_object", "arguments": {"bucketId": "...", "key": "photos/sunset.jpg", "contentType": "image/jpeg"}}}
\`\`\`

## More Information
- Documentation: https://docs.medialocker.io
- API Reference: https://api.medialocker.io/api/openapi.json
- Support: via app.medialocker.io
`;

async function sendLlmsTxt(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await reply.type("text/plain; charset=utf-8").send(LLMS_TXT_CONTENT);
}

/**
 * Register the public discovery routes. These carry NO auth — they are
 * registered on the root Fastify instance, outside the authenticated gateway
 * scope, so the auth / rate-limit / allowlist / audit / cache hooks never run.
 */
export function llmsTxtRoutes(app: FastifyInstance): void {
  app.get("/.well-known/llms.txt", sendLlmsTxt);
  app.get("/llms.txt", sendLlmsTxt);
  app.get("/mcp/llms.txt", sendLlmsTxt);
}

export { LLMS_TXT_CONTENT };
