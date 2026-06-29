# Uploading & Downloading

The CLI wraps the [presign → PUT → confirm](/developer/presign) flow, so object
bytes move directly between your machine and object storage — the API only issues
signed URLs and records the result.

## Upload

```bash
medialocker media upload ./hero.mp4 --bucket marketing
```

`--bucket` accepts a bucket **name or id**. Useful options:

| Option | Effect |
|---|---|
| `--bucket <id\|name>` | Destination bucket (required) |
| `--key <key>` | Object key; defaults to the filename (single file only) |
| `--content-type <type>` | Override the detected content type |
| `--tag <tag>` | Apply a tag; repeat for several |

Upload several files at once:

```bash
medialocker media upload ./shots/*.jpg --bucket product --tag catalog
```

Behind the scenes the CLI requests a presigned URL, PUTs the bytes, and calls
`confirm` to record the true size and enqueue derivatives. Files **≥ 100 MB**
automatically switch to the [multipart flow](/developer/presign#multipart-upload)
— parts are uploaded and completed for you.

With `--json`, a successful upload prints the confirmed object:

```json
{
  "objectId": "a17c…",
  "key": "hero.mp4",
  "size": "734003200",
  "bucketId": "b3f1…",
  "status": "confirmed"
}
```

## Download

```bash
medialocker media download <objectId> --out ./hero.mp4
```

| Option | Effect |
|---|---|
| `--out <path>` | Output path; defaults to the object key's basename |
| `--expires <seconds>` | Presigned URL lifetime (60–604800) |

## Presigned URLs

To hand a URL to another tool instead of downloading, print one:

```bash
medialocker media url <objectId> --expires 3600     # short-lived download URL
medialocker media thumbnail <objectId>              # thumbnail/poster URL
```

::: tip Scriptable round-trips
Both commands emit just the URL on stdout, so they pipe cleanly:

```bash
curl -o out.jpg "$(medialocker media url <objectId>)"
```
:::

## See also

- [Presigned Uploads](/developer/presign) — the underlying single-shot and multipart flow
- [Command Reference](/developer/cli/commands) — the rest of the `media` commands
