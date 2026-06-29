# Authentication

Every MediaLocker API request is authenticated and scoped to a single
**organization**. The API accepts three credential types, resolved in this order:

| Credential | Header | Who uses it |
|---|---|---|
| **API key** | `Authorization: Bearer <secret>` | Server-to-server integrations, scripts, MCP clients |
| **Supabase JWT** | `Authorization: Bearer <jwt>` | The dashboard (browser sessions) |
| **Internal HMAC** | `Authorization: Internal <ts>:<sig>` | First-party services inside the deployment |

All three resolve to the same internal context: an `orgId`, a set of **scopes**,
and (for keys) an optional **bucket scope**.

## API keys

An API key has two parts, both returned **once** when the key is created:

- **Access Key ID** — a public identifier of the form `ml_<32 hex>` (e.g. `ml_9f3c…`). Safe to log; identifies the key.
- **Secret Access Key** — a 64-character hex secret. This is the **bearer token** you send on requests. It is shown only at creation time and cannot be retrieved again.

Authenticate by sending the **secret** as a bearer token:

```bash
curl -H "Authorization: Bearer <secret-access-key>" \
  https://api.medialocker.io/api/media
```

::: warning Send the secret, not the access key ID
The `ml_…` Access Key ID is only an identifier. The value you put after `Bearer `
is the **Secret Access Key**. Authentication will fail if you send the `ml_…` value.
:::

### How keys are stored

Keys are never stored in plaintext. At creation the secret is encrypted at rest
with **AES-256-GCM**, and a **SHA-256** hash of the secret is stored as a lookup
index. On each request the presented token is hashed to find the key, then
compared against the decrypted secret with a **constant-time** comparison.

### Scopes

Each key carries one or more scopes. The `admin` scope implies all others.

| Scope | Grants |
|---|---|
| `read` | List and read media, buckets, sets, storyboards, usage |
| `write` | Create/update objects, tags, sets, presign uploads |
| `delete` | Delete media, buckets, and other resources |
| `admin` | Everything, including key management and billing |

### Bucket scope

A key may optionally be restricted to a **single bucket**. A bucket-scoped key can
only list, read, and mutate objects within that bucket — attempts to touch another
bucket return `403 Forbidden`.

### Expiry and rotation

Keys expire after a configurable window — **90 days by default** (maximum 365).
Rotate a key with `PUT /api-keys/{id}/rotate`, which issues a new secret and
immediately invalidates the old one. Create and revoke keys from the dashboard
under **API Keys**, or via the [REST API](/developer/api-reference) and the MCP
[`create_api_key`](/developer/mcp/tools) tool.

## Supabase JWTs (dashboard sessions)

The dashboard authenticates users with Supabase Auth and forwards the resulting
JWT as a bearer token. MediaLocker verifies the JWT, then resolves the caller's
organization and role from the `memberships` table:

- The user is identified by the JWT `sub` claim.
- Their **role** in the org maps to scopes: `owner` and `admin` → `read, write, delete, admin`; `member` → `read` only.
- A user in multiple orgs gets a deterministic default (highest role, then oldest membership). Pass `?org_id=<id>` to act on a specific org — membership is verified, and a non-member receives `403 Forbidden`.

You generally don't construct these tokens yourself; they're managed by the
dashboard session. For programmatic access, use an **API key**.

## Internal HMAC (service-to-service)

First-party services inside a deployment authenticate with a shared-secret HMAC
rather than a bearer token:

```
Authorization: Internal <unix-timestamp>:<hex-signature>
```

The signature is `HMAC-SHA256(INTERNAL_API_SECRET, "<METHOD>\n<path>\n<timestamp>")`
where `path` excludes the query string. The timestamp must be within **±60 seconds**
of the server clock, and an `?org_id=` query parameter is required (it sets the
acting organization). Internal requests are granted full `read, write, delete, admin`
scopes. Verification is **rotation-aware**: a signature valid under the current or
the immediately-previous secret is accepted during a rotation grace window.

::: info Not for third parties
Internal HMAC is for trusted services that already hold `INTERNAL_API_SECRET`.
External integrations should always use an API key.
:::

## Errors

A missing or invalid credential returns `401 Unauthorized`; a valid credential
without the required scope (or org membership) returns `403 Forbidden`. See
[Errors](/developer/errors) for the full envelope.
