# API Keys

API keys authenticate access to the MediaLocker API. Each key has configurable scopes and optional expiry.

## Creating an API Key

1. Navigate to **API Keys** in the sidebar.
2. Click **Create Key**.
3. Enter a name for the key (e.g., "CI/CD Pipeline", "Desktop App").
4. Select scopes:
   - **read** — Read objects and metadata
   - **write** — Upload and modify objects
   - **delete** — Delete objects
   - **admin** — Full account management
5. Optionally set an expiration date.
6. Click **Create**.

::: warning
The full secret key is shown **only once** after creation. Copy it immediately and store it securely.
:::

## Key Format

API keys have two parts, both shown once at creation:
- **Access Key ID**: `ml_<32 hex chars>` — a public identifier, safe to share and appears in logs
- **Secret Access Key**: `<64 hex chars>` — secret, equivalent to a password

Send the **Secret Access Key** as the bearer token when calling the API (see
below). The `ml_…` Access Key ID identifies the key but is **not** used as the
bearer token on its own.

## Managing Keys

### Rotating a Key

Click the **rotate** icon next to any key to generate a new secret while keeping the same key ID and scopes. The old secret is immediately invalidated.

### Revoking a Key

Click the **trash** icon to permanently revoke a key. Revoked keys cannot be restored.

### Key Expiry

Keys with expiry dates are automatically disabled after the expiry date. You can set or remove expiry during key creation.

## Using API Keys

### API Authentication

```bash
curl -H "Authorization: Bearer <secret-access-key>" \
  https://api.medialocker.io/api/media
```

API keys authenticate every REST API request. The API then issues short-lived presigned URLs for direct object uploads and downloads — there is no separate S3 access key. See the [Developer Docs](/developer/) for details.

## Plan Limits

<!--@include: ../shared/plan-limits.md-->
