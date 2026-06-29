# Tools

The full MCP tool catalog, grouped by the scope each tool requires. Required
arguments are shown in **bold**. Call `tools/list` to see the subset your credential
is actually permitted to use.

## Read tools

Require the `read` scope.

| Tool | Description | Arguments |
|---|---|---|
| `search_media` | Full-text search across media with filters for kind, tags, categories, size, date range, and bucket. | **`q`**, `kind`, `tags`, `categories`, `bucketId`, `sizeMin`, `sizeMax`, `limit`, `offset` |
| `list_buckets` | List all buckets in the organization with usage summaries. | — |
| `get_bucket_info` | Detailed information about a bucket, including usage statistics. | **`bucketId`** |
| `list_objects` | List objects in a bucket with optional prefix and pagination. | **`bucketId`**, `prefix`, `limit`, `offset` |
| `get_object_metadata` | Metadata and media-asset info for an object. | **`objectId`** |
| `get_object_url` | Generate a time-limited presigned download URL for an object. | **`objectId`**, `expiresIn` |
| `list_sets` | List all sets in the organization. | — |
| `get_usage` | Current storage usage, egress stats, and request counts. | — |
| `get_billing_info` | Current plan, add-on capacity, and billing details. | — |

## Write tools

Require the `write` scope.

| Tool | Description | Arguments |
|---|---|---|
| `upload_object` | Generate presigned upload instructions for an object. | **`bucketId`**, **`key`**, `contentType`, `size` |
| `create_bucket` | Create a new bucket (3–63 chars, lowercase, DNS-safe). | **`name`** |
| `manage_tags` | Create, list, or assign tags. | **`action`** (`create`/`list`/`assign`), `name`, `objectId`, `tagIds` |
| `manage_categories` | Create, list, or assign categories. | **`action`** (`create`/`list`/`assign`), `name`, `parentId`, `objectId`, `categoryIds` |
| `create_set` | Create a set for grouping variant renditions. | **`name`**, `baseObjectId` |
| `add_variant` | Add an object variant to a set with aspect ratio and size. | **`setId`**, **`objectId`**, `aspectRatio`, `width`, `height`, `role` |
| `generate_variants` | Trigger variant generation for all items in a set (enqueues media-processing jobs). | **`setId`** |
| `manage_capacity` | Add/remove capacity or configure auto-capacity. On billed deployments, `add` creates a prorated add-on and `remove` cancels whole add-ons (newest first). | **`action`** (`add`/`remove`/`auto`), `gb`, `enabled`, `incrementGb`, `thresholdPct`, `maxMonthlySpendCents` |

## Delete tools

Require the `delete` scope and pass through the [destructive-tool firewall](/developer/mcp/authentication#destructive-tool-firewall).

| Tool | Description | Arguments |
|---|---|---|
| `delete_object` | Soft-delete an object. | **`objectId`** |
| `delete_bucket` | Delete a bucket (must be empty). | **`bucketId`** |
| `purge` | Permanently hard-delete all soft-deleted objects in the organization. | **`confirm`** (must be `"DELETE"`) |

## Admin tools

Require the `admin` scope.

| Tool | Description | Arguments |
|---|---|---|
| `create_api_key` | Create a new API key. The secret is returned once. | **`name`**, `scopes`, `bucketId`, `expiresInDays` (default 90, max 365) |

## Example: search, then sign a URL

```ts
// Find landscape images
const found = await client.callTool({
  name: "search_media",
  arguments: { q: "landscape", kind: "image", limit: 10 },
});

// Get a presigned download URL for the first result
const obj = JSON.parse(found.content[0].text).results[0];
const url = await client.callTool({
  name: "get_object_url",
  arguments: { objectId: obj.id, expiresIn: 600 },
});
```

::: tip Uploads are presign-based
`upload_object` returns presigned upload **instructions**, not a byte sink. Your
client uploads directly to the returned URL and then confirms — the same flow as the
REST [Presigned Uploads](/developer/presign) endpoints.
:::
