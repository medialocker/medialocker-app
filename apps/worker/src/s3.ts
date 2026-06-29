import { S3Client } from '@aws-sdk/client-s3';
import { getConfig } from '@medialocker/config';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

let s3: S3Client | null = null;

/**
 * Stream an S3 GetObject body straight to a file on disk without buffering the
 * whole object in memory (large media — video especially — must not be loaded
 * via Buffer.concat). §6.3
 */
export async function streamObjectToFile(body: unknown, filePath: string): Promise<void> {
  if (!body) throw new Error('Empty S3 object body');
  await pipeline(body as Readable, createWriteStream(filePath));
}

/** Shared S3Client options (everything except credentials). */
function clientOptions() {
  const cfg = getConfig();
  return {
    endpoint: cfg.HETZNER_S3_ENDPOINT,
    region: cfg.HETZNER_S3_REGION,
    forcePathStyle: true,
    // (§P1) Explicit retry + timeout policy. The SDK otherwise applies no
    // socket/connection timeout, so a stalled connection can hang a worker
    // indefinitely and pin a concurrency slot. Bounded retries with adaptive
    // backoff handle transient blips; the timeouts cap a hung request.
    // requestTimeout is generous because large media bodies stream through this
    // client (GetObject → disk). The worker must run in the bucket's region so
    // these reads stay intra-region (§7.6).
    maxAttempts: 4,
    retryMode: 'adaptive' as const,
    requestHandler: {
      connectionTimeout: 5_000,
      requestTimeout: 120_000,
    },
  };
}

/**
 * Singleton accessor. Builds the client once from the Hetzner master credential
 * (§7.2). The single master cred rotates by env-swap + restart (§9).
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
 * Thin rotation hook (§7.2/§10). At runtime this is just the singleton — kept so
 * the many existing call sites (`await refreshS3Client()`) need no change.
 */
export async function refreshS3Client(): Promise<S3Client> {
  return getS3();
}

export const DERIVED_BUCKET = 'ml-derived';
