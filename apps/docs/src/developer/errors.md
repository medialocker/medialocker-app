# Errors

API errors use a consistent JSON envelope and standard HTTP status codes.

## Error envelope

Application errors return an `error` object with a machine-readable `code` and a
human-readable `message`:

```json
{
  "error": {
    "code": "NotFound",
    "message": "Bucket not found"
  }
}
```

::: info Two envelope shapes
Application/handler errors use the `{ "error": { "code", "message" } }` shape above.
Infrastructure-level responses from the HTTP layer — notably the rate limiter — use
Fastify's `{ "statusCode", "error", "message" }` shape instead. See
[Rate Limits](/developer/rate-limits).
:::

## Status codes

| Status | Code(s) | Meaning |
|---|---|---|
| `400` | `BadRequest`, `InvalidArgument`, `ValidationError`, `InvalidBucketName` | Malformed request, invalid argument, or failed validation |
| `401` | `Unauthorized` | Missing or invalid credentials |
| `403` | `Forbidden` | Authenticated, but lacking the required scope or org membership |
| `404` | `NotFound` | Resource does not exist (or isn't visible to your org) |
| `409` | `Conflict` | State conflict — duplicate bucket/category name, or a downgrade blocked by current usage |
| `429` | — | Rate limit exceeded (see [Rate Limits](/developer/rate-limits)) |
| `500` | `InternalError` | Unhandled server error |

## Validation errors

Request-body validation failures return `400` with a `details` array pinpointing
each offending field:

```json
{
  "error": {
    "code": "ValidationError",
    "message": "Request validation failed",
    "details": [
      { "path": "expiresIn", "message": "Number must be greater than or equal to 60" },
      { "path": "tags.0", "message": "Expected string, received number" }
    ]
  }
}
```

`path` is a dot-joined path into your request body (array indices included), so
`tags.0` refers to the first element of the `tags` array.

## Authorization errors

- `401 Unauthorized` — no credential, or a credential that failed verification. Check the `Authorization` header (see [Authentication](/developer/authentication)).
- `403 Forbidden` — the credential is valid but lacks the needed [scope](/developer/authentication#scopes), is restricted to a different bucket, or the user isn't a member of the requested organization. The message names the missing scope, e.g. `Missing required scope: write`.

::: tip Server errors never leak internals
`500 InternalError` responses carry only a generic message. Stack traces and
internal details are logged server-side and never returned to clients.
:::
