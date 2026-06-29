# API Reference

All endpoints are relative to `https://api.medialocker.io/api` and require
authentication. See [Authentication](/developer/authentication) for credentials and
scopes, [Errors](/developer/errors) for the error envelope, [Rate Limits](/developer/rate-limits)
for limits, and [Idempotency](/developer/idempotency) for safe retries.

::: tip Machine-readable spec
The full OpenAPI 3.0 document is served at `GET /api/openapi.json`.
:::

## Conventions

- **Auth:** send `Authorization: Bearer <secret-access-key>` (or a dashboard JWT). The bearer value is the API key's **secret**, not the `ml_…` access key ID.
- **List envelope:** list endpoints return `{ "data": [...], "total": N, "hasMore": bool }`. Search returns `{ "media": [...], "total": N, "facets": {...} }`.
- **IDs** are UUIDs. **Timestamps** are ISO-8601 UTC.

## Auth

### Current user

```http
GET /api/me
```

Returns the current user and their organization memberships.

### API keys

```http
GET    /api/api-keys
POST   /api/api-keys
DELETE /api/api-keys/{id}
PUT    /api/api-keys/{id}/rotate
```

Create body:

```json
{
  "name": "CI/CD Pipeline",
  "scopes": ["read", "write"],
  "bucketId": "<bucket-uuid>",
  "expiresInDays": 90
}
```

`scopes` defaults to `["read"]`; `bucketId` (optional) restricts the key to one
bucket; `expiresInDays` defaults to 90 (max 365). The response returns the secret
**once**:

```json
{
  "id": "<key-uuid>",
  "name": "CI/CD Pipeline",
  "accessKeyId": "ml_9f3c…",
  "secret": "<64-hex-secret>",
  "scopes": ["read", "write"],
  "expiresAt": "2026-09-26T00:00:00Z",
  "note": "Store this secret securely — it will not be shown again."
}
```

`PUT /api/api-keys/{id}/rotate` issues a new secret and invalidates the old one.

## Buckets

```http
GET    /api/buckets
POST   /api/buckets          { "name": "campaign-assets" }
GET    /api/buckets/{id}
DELETE /api/buckets/{id}
```

`DELETE` returns `409 Conflict` if the bucket is not empty.

## Media

```http
GET    /api/media
GET    /api/media/{id}
DELETE /api/media/{id}                 # soft-delete
PUT    /api/media/{id}/metadata        { "metadata": { "key": "value" } }
GET    /api/media/{id}/thumbnail       # streams the derived thumbnail/poster
GET    /api/media/{id}/stream          # 302 redirect to a presigned GET URL
```

`GET /api/media` query parameters:

| Param | Type | Description |
|---|---|---|
| `bucketId` | string | Restrict to a bucket |
| `kind` | enum | `image`, `video`, `audio`, `pdf`, `3d`, `other` |
| `search` | string | Substring match on key/filename |
| `sort` | enum | `created_at` (default), `size`, `key` |
| `order` | enum | `desc` (default), `asc` |
| `limit` | int | Page size (default 50) |
| `offset` | int | Pagination offset (default 0) |

Uploads are not a single endpoint — see [Presigned Uploads](/developer/presign).

## Tags

```http
GET    /api/tags?search=<q>
POST   /api/tags                       { "name": "hero" }
DELETE /api/tags/{id}
PUT    /api/objects/{id}/tags          { "tagIds": ["<tag-uuid>", …] }
```

`PUT /api/objects/{id}/tags` sets the complete tag list on an object (replaces, not appends).

## Categories

```http
GET    /api/categories                 # hierarchical tree
POST   /api/categories                 { "name": "Final", "parentId": "<uuid>" }
DELETE /api/categories/{id}
PUT    /api/objects/{id}/categories    { "categoryIds": ["<uuid>", …] }
```

Deleting a category reassigns its children to root and removes object assignments.

## Sets

Sets group variant renditions of media.

```http
GET    /api/sets
POST   /api/sets                       { "name": "Hero Variants", "baseObjectId": "<uuid>" }
GET    /api/sets/{id}
DELETE /api/sets/{id}
POST   /api/sets/{id}/items            { "objectId": "<uuid>", "aspectRatio": "16:9", "width": 1920, "height": 1080, "role": "hero" }
DELETE /api/sets/{id}/items/{itemId}
POST   /api/sets/{id}/generate         # 202 — enqueues variant generation
```

`POST /api/sets/{id}/generate` returns `202 Accepted`; variant rendering runs
asynchronously in the worker.

## Storyboards

Storyboards order clips into a sequence.

```http
GET    /api/storyboards
POST   /api/storyboards                { "name": "Final Cut" }
GET    /api/storyboards/{id}
DELETE /api/storyboards/{id}
POST   /api/storyboards/{id}/clips             { "objectId": "<uuid>", "position": 0, "note": "intro" }
PUT    /api/storyboards/{id}/clips/reorder     { "clipIds": ["<uuid>", …] }
PUT    /api/storyboards/{id}/clips/{clipId}    { "position": 2, "note": "…" }
DELETE /api/storyboards/{id}/clips/{clipId}
```

`reorder` returns `400` if `clipIds` don't all belong to the storyboard.

## Search

```http
GET /api/search?q=sunset&kind=image&tags=hero,final&limit=20
```

| Param | Type | Description |
|---|---|---|
| `q` | string | **Required** — full-text query |
| `kind` | string | Media kind filter |
| `tags` | string | Comma-separated tag slugs |
| `categories` | string | Comma-separated category slugs |
| `bucketId` | string | Restrict to a bucket |
| `sizeMin` / `sizeMax` | int | Size bounds in bytes |
| `dateFrom` / `dateTo` | string | ISO date bounds |
| `limit` / `offset` | int | Pagination (default 50 / 0) |

Response includes `facets` (tag, category, and kind counts) alongside `media` and `total`.

## Usage

```http
GET /api/usage
GET /api/usage/history?days=30
GET /api/usage/events?days=30&limit=100&offset=0
```

`GET /api/usage`:

```json
{
  "usedStorage": 53687091200,
  "allocatedStorage": 107374182400,
  "egressThisMonth": 1073741824,
  "apiCallsThisMonth": 5000,
  "objectCount": 1234
}
```

## Billing

```http
GET  /api/billing/subscription
POST /api/billing/capacity/add        { "gb": 100 }
PUT  /api/billing/capacity/auto       { "enabled": true, "incrementGb": 100, "thresholdPct": 80, "maxMonthlySpendCents": 5000 }
POST /api/billing/downgrade           { "tierKey": "starter" }
GET  /api/billing/invoices
GET  /api/billing/portal
```

`downgrade` returns `409` when current usage exceeds the target plan. `invoices`
returns `501` if Stripe isn't configured. `portal` returns a Stripe Customer Portal URL.

## Presign

Direct-to-storage upload and download. See [Presigned Uploads](/developer/presign)
for the full flow.

```http
POST /api/presign/upload              { "bucketId", "key", "contentType?", "size?", "tags?" }
POST /api/presign/create-multipart    { "bucketId", "key", "contentType?", "size?" }
POST /api/presign/upload-part         { "bucketId", "key", "uploadId", "partNumber", "contentType?" }
POST /api/presign/complete-upload     { "bucketId", "key", "uploadId", "tags?" }
POST /api/presign/confirm             { "bucketId", "key" }
POST /api/presign/download            { "objectId", "expiresIn?" }
```

## Webhook

```http
POST /api/stripe/webhook
```

Unauthenticated Stripe event receiver (verified by Stripe signature). Not for
general use; excluded from [idempotency](/developer/idempotency).
