import { S3Client } from "@aws-sdk/client-s3";
import { getConfig } from "@medialocker/config";

let s3: S3Client | null = null;

function buildClient(accessKeyId: string, secretAccessKey: string): S3Client {
  const cfg = getConfig();
  return new S3Client({
    endpoint: cfg.HETZNER_S3_ENDPOINT,
    region: cfg.HETZNER_S3_REGION,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}

/**
 * Singleton Hetzner Object Storage client for the MCP server, configured
 * identically to the api + worker (master credential from shared config, §7.2).
 * MCP uses it to keep storage in sync with the control-plane DB: create the
 * backing bucket on `create_bucket` and remove real bytes on `purge`/`delete`.
 * The single master cred rotates by env-swap + restart (§9).
 */
export function getS3(): S3Client {
  if (!s3) {
    const cfg = getConfig();
    s3 = buildClient(cfg.HETZNER_S3_ACCESS_KEY, cfg.HETZNER_S3_SECRET_KEY);
  }
  return s3;
}

/** Thin rotation hook (§7.2/§10) — singleton at runtime; keeps call sites stable. */
export async function refreshS3Client(): Promise<S3Client> {
  return getS3();
}

// Private system bucket holding generated derivatives (thumbnails/posters/etc).
// Must match DERIVED_BUCKET in apps/worker + apps/api.
export const DERIVED_BUCKET = "ml-derived";
