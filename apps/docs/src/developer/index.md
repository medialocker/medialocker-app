# Developer Documentation

MediaLocker is driven entirely through its API surface — no byte ever transits the
control plane. Build against the REST API, an MCP client, or both.

- **REST API** — full CRUD over media, buckets, tags, categories, sets, storyboards, API keys, usage, and billing.
- **Presigned URLs** — clients upload and download object bytes directly to storage over short-lived signed URLs.
- **MCP server** — a Model Context Protocol server for AI agents, exposing the same capabilities as scoped tools.
- **CLI** — the `medialocker` command-line client for terminals and scripts, driving the same REST API.
- **llms.txt** — machine-readable discovery for LLMs and coding assistants.

## What's here

| Page | Covers |
|---|---|
| [Authentication](/developer/authentication) | API keys, scopes, bucket scope, Supabase JWTs, internal HMAC |
| [Rate Limits](/developer/rate-limits) | REST (300/min) and MCP limits, `429` handling |
| [Errors](/developer/errors) | Error envelope, status codes, validation details |
| [Idempotency](/developer/idempotency) | `Idempotency-Key` semantics for safe retries |
| [Presigned Uploads](/developer/presign) | Single-shot and multipart uploads, downloads, tagging |
| [API Reference](/developer/api-reference) | Endpoint-by-endpoint REST reference |
| [Command Line (CLI)](/developer/cli/) | Install, auth, commands, uploads, and a local MCP server |
| [MCP Server](/developer/mcp/) | Connecting, tools, resources, and limits for AI agents |

## Base URLs

| Service | URL |
|---|---|
| REST API | `https://api.medialocker.io` |
| MCP Server | `https://mcp.medialocker.io` |

## Authentication at a glance

Send an API key's **Secret Access Key** as a bearer token:

```bash
curl -H "Authorization: Bearer <secret-access-key>" \
  https://api.medialocker.io/api/media
```

Create and manage keys from the dashboard under **API Keys**, or via the
[REST API](/developer/api-reference). Each key carries scopes (`read`, `write`,
`delete`, `admin`) and may be restricted to a single bucket. See
[Authentication](/developer/authentication) for the full model.

## Quick start: upload a file

Uploads are a presign → PUT → confirm flow — the API issues a signed URL, your
client sends the bytes directly to storage, then you confirm:

```bash
# 1. Ask the API for a presigned upload URL
curl -X POST https://api.medialocker.io/api/presign/upload \
  -H "Authorization: Bearer <secret-access-key>" \
  -H "Content-Type: application/json" \
  -d '{"bucketId": "<bucket-uuid>", "key": "photo.jpg", "contentType": "image/jpeg", "size": 1048576}'

# 2. PUT the bytes directly to the returned URL (send any headers it returned)
curl -X PUT --upload-file photo.jpg -H "Content-Type: image/jpeg" "<url-from-step-1>"

# 3. Confirm — records the true size and enqueues derivatives
curl -X POST https://api.medialocker.io/api/presign/confirm \
  -H "Authorization: Bearer <secret-access-key>" \
  -H "Content-Type: application/json" \
  -d '{"bucketId": "<bucket-uuid>", "key": "photo.jpg"}'
```

For large files, use the [multipart flow](/developer/presign#multipart-upload).

::: info S3-compatible endpoint retired
The customer-facing S3-compatible endpoint (SigV4 against `s3.medialocker.io`) has
been retired. All access now goes through the REST API and presigned URLs — see
[Presigned Uploads](/developer/presign).
:::
