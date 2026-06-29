# Integrations

MediaLocker provides APIs and hooks for building integrations, plugins, and automated workflows.

## OAuth Apps

::: info Planned Feature
OAuth App registration and management is planned for an upcoming release. This will allow third-party developers to build apps that access MediaLocker on behalf of users.
:::

Planned capabilities:
- OAuth 2.0 authorization code flow
- Configurable scopes (read, write, delete, admin)
- Webhook subscriptions per app
- App listing and discovery

## Plugins

::: info Planned Feature
A plugin system for extending MediaLocker functionality is planned for an upcoming release.
:::

Planned plugin types:
- **Media processors** — Transform media on upload (transcode, resize, watermark)
- **Metadata extractors** — Extract and index custom metadata
- **Storage backends** — Custom storage destinations
- **Auth providers** — Additional authentication methods
- **UI extensions** — Custom dashboard panels and views

## Webhooks

::: info Planned Feature
Webhook delivery for real-time event notifications is planned for an upcoming release.
:::

Planned event types:
- `media.created` — A new media file was uploaded
- `media.updated` — Media metadata was modified
- `media.deleted` — A media file was deleted
- `bucket.created` — A new bucket was created
- `bucket.deleted` — A bucket was deleted
- `set.created` / `set.updated` / `set.deleted`
- `storyboard.created` / `storyboard.updated` / `storyboard.deleted`

Webhook delivery will include:
- Configurable endpoints per event type
- Retry with exponential backoff
- Delivery logs and monitoring
- Secret-based payload signing

## Third-Party Integrations

Integrate with MediaLocker through the REST API and presigned URLs:

- **CI/CD** — Upload build artifacts by requesting a presigned URL from the API and `PUT`ing to it
- **Backup tools** — Push and pull objects via API-issued presigned URLs
- **Media tools** — Fetch originals and derivatives through presigned download URLs
- **Data pipelines** — Drive ingestion and retrieval through the REST API
- **AI/ML** — Store training data and retrieve it via the API and MCP tools

For integration details, see the [API Reference](/developer/api-reference).
