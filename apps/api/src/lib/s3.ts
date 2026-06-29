import { S3Client } from "@aws-sdk/client-s3";
import { getConfig } from "@medialocker/config";

let s3: S3Client | null = null;

/**
 * Hetzner Object Storage client for the control plane. Holds the single
 * project-scoped MASTER credential (api/worker/mcp are the only holders, §9).
 * Used to provision buckets, presign tenant URLs, and read system derivatives
 * out of the private `ml-derived` bucket. Never exposed client-side — only
 * short-lived presigned URLs leave the backend.
 */
function clientOptions() {
  const cfg = getConfig();
  return {
    endpoint: cfg.HETZNER_S3_ENDPOINT,
    region: cfg.HETZNER_S3_REGION,
    // Path-style addressing (`<endpoint>/<bucket>/<key>`): the dev/CI MinIO
    // default requires it and Hetzner accepts it, so one setting works in both.
    // Virtual-host addressing is a post-spike change gated on §3 (G1).
    forcePathStyle: true,
    maxAttempts: 3,
  };
}

/**
 * Singleton accessor. Builds the client once from the master credential.
 * (§7.2 — collapsed from the old rotation-polling builder; the single master
 * cred rotates by env-swap + restart, §9.)
 */
export function getS3(): S3Client {
  if (!s3) {
    const cfg = getConfig();
    s3 = new S3Client({
      ...clientOptions(),
      credentials: {
        accessKeyId: cfg.HETZNER_S3_ACCESS_KEY,
        secretAccessKey: cfg.HETZNER_S3_SECRET_KEY,
      },
    });
  }
  return s3;
}

/**
 * Thin rotation hook (§7.2/§10). The master credential rotates via env-swap +
 * restart, so at runtime this is just the singleton — kept so existing call
 * sites need no change and a future in-process rotation has a seam.
 */
export async function refreshS3Client(): Promise<S3Client> {
  return getS3();
}

/** Reset the singleton (test seam / post-rotation). */
export function resetS3Client(): void {
  s3 = null;
}

export const DERIVED_BUCKET = "ml-derived";
