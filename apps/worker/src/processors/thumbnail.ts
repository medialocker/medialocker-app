import type { Job } from 'bullmq';
import { z } from 'zod';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import { runFfmpeg } from '../ffmpeg';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MediaKind } from '@medialocker/media';
import { getDb } from '../db';
import { getS3, refreshS3Client, DERIVED_BUCKET, streamObjectToFile } from '../s3';
import { logger } from '../logger';

export interface ThumbnailJobData {
  objectId: string;
  orgId: string;
  minioBucket: string;
  key: string;
  kind: MediaKind;
  width?: number;
  height?: number;
  durationMs?: number;
}

export const ThumbnailJobSchema = z.object({
  objectId: z.string(),
  orgId: z.string(),
  minioBucket: z.string(),
  key: z.string(),
  kind: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  durationMs: z.number().optional(),
});

const THUMBNAIL_WIDTH = 400;

export async function processThumbnailJob(job: Job<ThumbnailJobData>): Promise<void> {
  const data = ThumbnailJobSchema.parse(job.data);
  const { objectId, orgId, minioBucket, key, kind, durationMs } = data;
  const logCtx = { objectId, orgId, key, kind, jobId: job.id };

  logger.info(logCtx, 'Generating thumbnail');

  await refreshS3Client(); // §5: pick up a rotated MinIO secret (fail-safe no-op otherwise)
  const s3 = getS3();
  const db = getDb();

  let thumbnailBuffer: Buffer;
  let thumbWidth: number;
  let thumbHeight: number;

  if (kind === MediaKind.Image || kind === MediaKind.Video) {
    // Stream the source to disk (no in-memory Buffer.concat). §6.3
    const tmpSource = join(tmpdir(), `ml-thumb-src-${randomUUID()}`);
    const response = await s3.send(new GetObjectCommand({ Bucket: minioBucket, Key: key }));
    await streamObjectToFile(response.Body, tmpSource);

    try {
      if (kind === MediaKind.Image) {
        const metadata = await sharp(tmpSource).metadata();
        const srcWidth = metadata.width || THUMBNAIL_WIDTH;
        const srcHeight = metadata.height || THUMBNAIL_WIDTH;
        const aspectRatio = srcWidth / srcHeight;

        thumbWidth = THUMBNAIL_WIDTH;
        thumbHeight = Math.round(THUMBNAIL_WIDTH / aspectRatio);
        if (thumbHeight % 2 !== 0) thumbHeight += 1;

        thumbnailBuffer = await sharp(tmpSource)
          .resize(thumbWidth, thumbHeight, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();

        const outMeta = await sharp(thumbnailBuffer).metadata();
        thumbWidth = outMeta.width || thumbWidth;
        thumbHeight = outMeta.height || thumbHeight;
      } else {
        const tmpOutput = join(tmpdir(), `ml-thumb-out-${randomUUID()}.jpg`);
        try {
          await runFfmpeg(
            ffmpeg(tmpSource)
              .seekInput(0.1)
              .frames(1)
              .outputOptions(['-q:v', '2'])
              .output(tmpOutput),
            { timeoutMs: 5 * 60 * 1000, logCtx },
          );

          const rawThumb = await readFile(tmpOutput);
          const meta = await sharp(rawThumb).metadata();
          const srcWidth = meta.width || THUMBNAIL_WIDTH;
          const srcHeight = meta.height || THUMBNAIL_WIDTH;
          const aspectRatio = srcWidth / srcHeight;

          thumbWidth = THUMBNAIL_WIDTH;
          thumbHeight = Math.round(THUMBNAIL_WIDTH / aspectRatio);
          if (thumbHeight % 2 !== 0) thumbHeight += 1;

          thumbnailBuffer = await sharp(rawThumb)
            .resize(thumbWidth, thumbHeight, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();

          const outMeta = await sharp(thumbnailBuffer).metadata();
          thumbWidth = outMeta.width || thumbWidth;
          thumbHeight = outMeta.height || thumbHeight;
        } finally {
          await rm(tmpOutput, { force: true }).catch(() => {});
        }
      }
    } finally {
      await rm(tmpSource, { force: true }).catch(() => {});
    }
  } else if (kind === MediaKind.Audio) {
    thumbWidth = THUMBNAIL_WIDTH;
    thumbHeight = THUMBNAIL_WIDTH;
    thumbnailBuffer = await sharp({
      create: {
        width: THUMBNAIL_WIDTH,
        height: THUMBNAIL_WIDTH,
        channels: 3,
        background: { r: 30, g: 30, b: 40 },
      },
    })
      .jpeg({ quality: 80 })
      .toBuffer();
  } else {
    thumbWidth = THUMBNAIL_WIDTH;
    thumbHeight = THUMBNAIL_WIDTH;
    thumbnailBuffer = await sharp({
      create: {
        width: THUMBNAIL_WIDTH,
        height: THUMBNAIL_WIDTH,
        channels: 3,
        background: { r: 60, g: 60, b: 70 },
      },
    })
      .jpeg({ quality: 80 })
      .toBuffer();
  }

  const derivativeKey = `${orgId}/${objectId}/thumbnail`;

  await s3.send(
    new PutObjectCommand({
      Bucket: DERIVED_BUCKET,
      Key: derivativeKey,
      Body: thumbnailBuffer,
      ContentType: 'image/jpeg',
    }),
  );

  const thumbBytes = thumbnailBuffer.length;

  await db`
    INSERT INTO derivatives (object_id, type, minio_key, width, height, bytes, billable)
    VALUES (${objectId}, 'thumbnail', ${derivativeKey}, ${thumbWidth}, ${thumbHeight}, ${thumbBytes}, false)
    ON CONFLICT (object_id, type, minio_key) DO UPDATE SET
      minio_key = EXCLUDED.minio_key,
      width = EXCLUDED.width,
      height = EXCLUDED.height,
      bytes = EXCLUDED.bytes,
      billable = EXCLUDED.billable
  `;

  logger.info({ ...logCtx, thumbWidth, thumbHeight, bytes: thumbBytes }, 'Thumbnail generated');
}
