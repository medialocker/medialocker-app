import type { Job } from 'bullmq';
import { z } from 'zod';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { probeFile, MediaKind } from '@medialocker/media';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { getS3, refreshS3Client, streamObjectToFile } from '../s3';
import { thumbnailQueue, posterQueue, spriteQueue } from '../queues';
import { refreshSearchIndex } from '../search-index';
import { logger } from '../logger';

export interface ProbeJobData {
  objectId: string;
  orgId: string;
  bucketId: string;
  minioBucket: string;
  key: string;
  contentType: string;
  size: number;
}

export const ProbeJobSchema = z.object({
  objectId: z.string(),
  orgId: z.string(),
  bucketId: z.string(),
  minioBucket: z.string(),
  key: z.string(),
  contentType: z.string(),
  size: z.number(),
});

export async function processProbeJob(job: Job<ProbeJobData>): Promise<void> {
  const data = ProbeJobSchema.parse(job.data);
  const { objectId, orgId, bucketId, minioBucket, key, contentType, size } = data;
  const logCtx = { objectId, orgId, key, jobId: job.id };

  logger.info(logCtx, 'Starting media probe');

  // §5: pick up a rotated MinIO secret before using the client (no-op unless a
  // newer `current` version exists; fail-safe to the env-cred client).
  await refreshS3Client();
  const s3 = getS3();
  const db = getDb();

  // Stream the source to a temp file rather than buffering it in memory; probeFile
  // (sharp/ffprobe) reads from the path. §6.3
  const tmpPath = join(tmpdir(), `ml-probe-src-${randomUUID()}`);
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: minioBucket,
        Key: key,
      }),
    );
    await streamObjectToFile(response.Body, tmpPath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    logger.error({ ...logCtx, error: String(err) }, 'Failed to stream object from MinIO for probe');
    throw err;
  }

  const extension = key.includes('.') ? key.split('.').pop() : undefined;
  let probeResult;
  try {
    probeResult = await probeFile(tmpPath, contentType, extension);
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }

  await db`
    INSERT INTO media_assets (
      object_id, kind, width, height, duration_ms, codec, frame_rate, has_audio, probe_json
    ) VALUES (
      ${objectId},
      ${probeResult.kind},
      ${probeResult.width ?? null},
      ${probeResult.height ?? null},
      ${probeResult.duration_ms ?? null},
      ${probeResult.codec ?? null},
      ${probeResult.frame_rate ?? null},
      ${probeResult.has_audio ?? null},
      ${db.json(JSON.parse(JSON.stringify(probeResult.probe_json ?? {})))}
    )
    ON CONFLICT (object_id) DO UPDATE SET
      kind = EXCLUDED.kind,
      width = EXCLUDED.width,
      height = EXCLUDED.height,
      duration_ms = EXCLUDED.duration_ms,
      codec = EXCLUDED.codec,
      frame_rate = EXCLUDED.frame_rate,
      has_audio = EXCLUDED.has_audio,
      probe_json = EXCLUDED.probe_json
  `;

  // Include the object's current etag so an OVERWRITE (new etag, same objectId)
  // enqueues FRESH derivative jobs. With a bare `probe-${objectId}` jobId, the
  // previous version's COMPLETED jobs linger (removeOnComplete age ~1h) and BullMQ
  // silently no-ops the re-add — so a quick overwrite never regenerated thumbnails
  // /posters/sprites. The etag changes per version, restoring regeneration while
  // still deduping identical re-probes. (W6)
  const etagRows = await db<{ etag: string }[]>`SELECT etag FROM objects WHERE id = ${objectId} LIMIT 1`;
  const ver = (etagRows[0]?.etag ?? "v").slice(0, 16);
  const enqueueJobId = `probe-${objectId}-${ver}`;

  if (probeResult.kind === MediaKind.Image) {
    await thumbnailQueue.add(
      'media:thumbnail',
      {
        objectId,
        orgId,
        minioBucket,
        key,
        kind: probeResult.kind,
        width: probeResult.width,
        height: probeResult.height,
      },
      { jobId: `${enqueueJobId}-thumb`, override: true } as any,
    );
  }

  if (probeResult.kind === MediaKind.Video) {
    await thumbnailQueue.add(
      'media:thumbnail',
      {
        objectId,
        orgId,
        minioBucket,
        key,
        kind: probeResult.kind,
        width: probeResult.width,
        height: probeResult.height,
        durationMs: probeResult.duration_ms,
      },
      { jobId: `${enqueueJobId}-thumb`, override: true } as any,
    );

    await posterQueue.add(
      'media:poster',
      {
        objectId,
        orgId,
        minioBucket,
        key,
        durationMs: probeResult.duration_ms,
        width: probeResult.width,
        height: probeResult.height,
      },
      { jobId: `${enqueueJobId}-poster`, override: true } as any,
    );

    await spriteQueue.add(
      'media:sprite',
      {
        objectId,
        orgId,
        minioBucket,
        key,
        durationMs: probeResult.duration_ms,
        width: probeResult.width,
        height: probeResult.height,
      },
      { jobId: `${enqueueJobId}-sprite`, override: true } as any,
    );
  }

  // Populate the full-text search index now that the object's media metadata
  // is in place. Derives filename + tags + user metadata for this object.
  await refreshSearchIndex(db, objectId);

  await db`
    INSERT INTO audit_log (org_id, actor, action, target, ip, ts)
    VALUES (${orgId}, 'worker', 'media:probe', ${objectId}, '0.0.0.0', now())
  `;

  logger.info({ ...logCtx, kind: probeResult.kind }, 'Media probe complete');
}
