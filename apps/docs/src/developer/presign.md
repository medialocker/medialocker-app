# Presigned Uploads &amp; Downloads

MediaLocker never proxies object bytes. Instead, the API issues short-lived
**presigned URLs**, and your client transfers data directly to and from storage.
This keeps large media off the API path and lets uploads and downloads scale with
the storage backend.

::: info The S3-compatible (SigV4) endpoint is retired
A customer-facing S3-compatible endpoint (SigV4 against `s3.medialocker.io`) once
existed; it has been **retired**. All object access now goes through the REST API
and presigned URLs. The API still uses AWS SigV4 internally to sign those URLs with
a single master storage credential that is never exposed to clients.
:::

All presign endpoints require the `write` scope (downloads require `read`) and
resolve the target bucket by `bucketId`, confirming it belongs to your
organization before signing anything.

## Single-shot upload

For ordinary files, request one presigned `PUT`, upload the bytes, then confirm.

### 1. Request a presigned URL

```bash
curl -X POST https://api.medialocker.io/api/presign/upload \
  -H "Authorization: Bearer <secret>" \
  -H "Content-Type: application/json" \
  -d '{
    "bucketId": "b3f1…",
    "key": "photos/sunset.jpg",
    "contentType": "image/jpeg",
    "size": 1048576,
    "tags": ["hero", "landscape"]
  }'
```

Response:

```json
{
  "url": "https://…storage…/photos/sunset.jpg?X-Amz-Signature=…",
  "method": "PUT",
  "key": "photos/sunset.jpg",
  "bucketId": "b3f1…",
  "bucket": "campaign-assets",
  "expiresIn": 3600,
  "headers": {
    "Content-Type": "image/jpeg",
    "x-amz-tagging": "hero&landscape"
  }
}
```

`size` is an **optimistic** quota reserve — the authoritative size is measured at
confirm. Any `headers` returned must be sent verbatim on the upload.

### 2. Upload the bytes

```bash
curl -X PUT --upload-file sunset.jpg \
  -H "Content-Type: image/jpeg" \
  -H "x-amz-tagging: hero&landscape" \
  "<url-from-step-1>"
```

### 3. Confirm

```bash
curl -X POST https://api.medialocker.io/api/presign/confirm \
  -H "Authorization: Bearer <secret>" \
  -H "Content-Type: application/json" \
  -d '{"bucketId": "b3f1…", "key": "photos/sunset.jpg"}'
```

Confirm is authoritative: the API `HEAD`s the uploaded object to record its true
size, reconciles your organization's quota, and **enqueues derivative generation**
(thumbnails, posters, and other variants).

::: warning Always confirm
Until you call `confirm`, the object exists in storage but the platform hasn't
trued-up quota or generated derivatives for it. Treat confirm as the final step of
every upload.
:::

## Multipart upload

For large files, upload in parts. Each part gets its own presigned `PUT`.

| Step | Endpoint | Body |
|---|---|---|
| 1. Initiate | `POST /presign/create-multipart` | `bucketId`, `key`, `contentType?`, `size?` |
| 2. Each part | `POST /presign/upload-part` | `bucketId`, `key`, `uploadId`, `partNumber` (1–10000), `contentType?` |
| 3. Complete | `POST /presign/complete-upload` | `bucketId`, `key`, `uploadId`, `tags?` |
| 4. Confirm | `POST /presign/confirm` | `bucketId`, `key` |

Initiate returns an `uploadId`. For each chunk, request a presigned URL with the
part's `partNumber`, `PUT` the chunk, and keep the returned `ETag`. After all parts
upload, call complete to assemble the object, then `confirm` exactly as for a
single-shot upload.

## Download

Request a presigned `GET` for an object by its ID:

```bash
curl -X POST https://api.medialocker.io/api/presign/download \
  -H "Authorization: Bearer <secret>" \
  -H "Content-Type: application/json" \
  -d '{"objectId": "a17c…", "expiresIn": 3600}'
```

Response:

```json
{ "url": "https://…", "method": "GET", "objectId": "a17c…", "key": "photos/sunset.jpg", "expiresIn": 3600 }
```

`expiresIn` is in seconds, between **60** and **604800** (7 days), defaulting to
**3600**. As a convenience, `GET /api/media/{id}/stream` issues a presigned URL and
**redirects** to it in one hop.

## Tagging on upload

Pass `tags` (up to 10 flat string labels, each ≤128 chars) to `presign/upload` or
`complete-upload`. They're applied atomically with the object via the
`x-amz-tagging` header — when the API returns that header, send it on your upload
request exactly as given.
