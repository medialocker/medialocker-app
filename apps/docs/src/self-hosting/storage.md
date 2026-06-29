# Storage Backend

MediaLocker stores all media objects in **Hetzner Object Storage** (S3-compatible). Storage is managed entirely by the backend — tenants never talk to Hetzner directly with credentials. They interact only through the REST API and short-lived presigned URLs.

## Architecture

```
                ┌────────────────────────────────────┐
                │  Backend (api / worker / mcp)       │
                │  holds the single master credential │
                └────────────────────────────────────┘
                       │ provisions / signs
                       ▼
                ┌────────────────────────────────────┐
                │  Hetzner Object Storage (1 project) │
                │  private buckets, one per tenant    │
                └────────────────────────────────────┘
                       ▲
                       │ presigned PUT / GET (direct)
                ┌────────────────────────────────────┐
                │  Tenant browser / client            │
                └────────────────────────────────────┘
```

- **One Hetzner project.** All tenant buckets live in a single Hetzner Object Storage project.
- **A single master credential.** Held only by the backend services (`api`, `worker`, `mcp`). It is never exposed to tenants or the browser.
- **Buckets are provisioned via the API.** Bucket lifecycle (create, list, delete) is driven through the MediaLocker REST API, which calls Hetzner on the tenant's behalf.
- **Tenants get presigned URLs.** Uploads and downloads happen browser-to-Hetzner directly using short-lived presigned URLs issued by the backend. No tenant ever receives a long-lived storage credential.
- **The worker runs in-region.** Derivative generation (thumbnails, transcodes) runs on a worker deployed in the same Hetzner region as the bucket data to keep object transfer fast and cheap.

## Privacy Model

- All buckets are **private**. There are no public buckets in v1.
- Every object is reached through a presigned URL with a limited expiry; objects are never served from a public bucket policy.
- Because the master credential lives only in the backend, access control and quotas are enforced by the API rather than by storage-level ACLs.

## Credentials

The master Hetzner Object Storage credential is supplied to the backend through environment variables (see [Environment Variables](/self-hosting/environment)). Never commit these values, expose them to tenants, or embed them in client-side code.
