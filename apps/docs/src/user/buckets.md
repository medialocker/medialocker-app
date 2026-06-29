# Buckets

Buckets are the top-level containers for your media. Each bucket holds files (objects) and can have its own settings.

## Creating a Bucket

1. Navigate to **Buckets** in the sidebar.
2. Click **Create Bucket**.
3. Enter a name (lowercase letters, numbers, and hyphens only).
4. Click **Create**.

Bucket name rules:
- 3–63 characters
- Lowercase letters, numbers, and hyphens only
- Must start and end with a letter or number
- Must be unique within your organization

## Managing Buckets

### Viewing Bucket Contents

Click a bucket to view its contents in the Media Library. You'll see all files stored in that bucket with their metadata.

### Deleting a Bucket

::: danger
Deleting a bucket permanently removes all objects within it. This action cannot be undone.
:::

1. Navigate to **Buckets**.
2. Click the trash icon next to the bucket.
3. Confirm the deletion.

## Plan Limits

<!--@include: ../shared/plan-limits.md-->

## Programmatic Access

Buckets are accessed through the MediaLocker REST API using your API key. Uploads and downloads use short-lived presigned URLs the API issues on request, so your client talks to storage directly without ever holding a storage credential. The previous customer-facing S3-compatible endpoint has been retired. See the [Developer Docs](/developer/) for details.
