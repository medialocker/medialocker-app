# Uploading Files

MediaLocker supports multiple upload methods through the dashboard and API.

## Dashboard Upload

### Drag-and-Drop

1. Navigate to **Upload** in the sidebar.
2. Drag files from your computer into the drop zone.
3. Files appear in the upload list with progress indicators.
4. Click **Upload All** to start the upload.

### File Browser

1. Click the drop zone to open your file browser.
2. Select one or more files.
3. Click **Upload All**.

## Multipart Upload

Large files are automatically uploaded using multipart upload for reliability:

1. **Initiate** — The dashboard requests presigned upload URLs from the API.
2. **Upload Parts** — Each part (5 MB chunks) is uploaded directly to storage via its presigned URL.
3. **Complete** — Once all parts are uploaded, the API completes the multipart upload.

This means:
- Large files (up to the **5 GB** per-file maximum) upload reliably.
- Failed parts can be retried independently.
- Upload progress is tracked per-part.

::: tip Per-file limit vs. storage capacity
The 5 GB ceiling is the maximum size of a **single file** and is the same on every
plan. Your plan determines total **storage capacity** (see [Usage & Billing](/user/usage-billing)), not how large an individual upload can be.
:::

## API Upload

See [Presigned Uploads](/developer/presign) for the full API upload flow:

- `POST /api/presign/upload` — Get a presigned URL for a single-shot upload
- `POST /api/presign/create-multipart` → `upload-part` → `complete-upload` — Multipart upload for large files
- `POST /api/presign/confirm` — Confirm the upload (records size, enqueues derivatives)

Each part is uploaded directly to a presigned URL returned by the API, so the file bytes go straight from your client to storage.

## Supported File Types

MediaLocker accepts all file types. Built-in viewers are available for:

| Type | Formats |
|---|---|
| Images | JPG, PNG, GIF, WebP, AVIF, SVG, TIFF |
| Video | MP4, WebM, MOV, AVI, MKV |
| Audio | MP3, WAV, FLAC, OGG, AAC |
| Documents | PDF, plain text |
