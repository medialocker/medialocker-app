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
import { getDb } from '../db';
import { getS3, refreshS3Client, DERIVED_BUCKET, streamObjectToFile } from '../s3';
import { logger } from '../logger';

export interface PosterJobData {
  objectId: string;
  orgId: string;
  minioBucket: string;
  key: string;
  durationMs?: number;
  width?: number;
  height?: number;
}

export const PosterJobSchema = z.object({
  objectId: z.string(),
  orgId: z.string(),
  minioBucket: z.string(),
  key: z.string(),
  durationMs: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

export async function processPosterJob(job: Job<PosterJobData>): Promise<void> {
  const data = PosterJobSchema.parse(job.data);
  const { objectId, orgId, minioBucket, key, durationMs } = data;
  const logCtx = { objectId, orgId, key, jobId: job.id };

  logger.info(logCtx, 'Generating poster frame');

  await refreshS3Client(); // §5: pick up a rotated MinIO secret (fail-safe no-op otherwise)
  const s3 = getS3();
  const db = getDb();

  // Stream the source to disk rather than buffering it in memory. §6.3
  const tmpInput = join(tmpdir(), `ml-poster-in-${randomUUID()}`);
  const tmpOutput = join(tmpdir(), `ml-poster-out-${randomUUID()}.jpg`);
  const response = await s3.send(new GetObjectCommand({ Bucket: minioBucket, Key: key }));
  await streamObjectToFile(response.Body, tmpInput);

  try {
    const seekTime = durationMs ? (durationMs / 1000) * 0.1 : 1;

    await runFfmpeg(
      ffmpeg(tmpInput)
        .seekInput(seekTime)
        .frames(1)
        .outputOptions(['-q:v', '2'])
        .output(tmpOutput),
      { timeoutMs: 5 * 60 * 1000, logCtx },
    );

    const rawFrame = await readFile(tmpOutput);
    const posterBuffer = await sharp(rawFrame)
      .jpeg({ quality: 85 })
      .toBuffer();

    const meta = await sharp(posterBuffer).metadata();
    const posterWidth = meta.width || 0;
    const posterHeight = meta.height || 0;

    const derivativeKey = `${orgId}/${objectId}/poster`;

    await s3.send(
      new PutObjectCommand({
        Bucket: DERIVED_BUCKET,
        Key: derivativeKey,
        Body: posterBuffer,
        ContentType: 'image/jpeg',
      }),
    );

    await db`
      INSERT INTO derivatives (object_id, type, minio_key, width, height, bytes, billable)
      VALUES (${objectId}, 'poster', ${derivativeKey}, ${posterWidth}, ${posterHeight}, ${posterBuffer.length}, false)
      ON CONFLICT (object_id, type, minio_key) DO UPDATE SET
        minio_key = EXCLUDED.minio_key,
        width = EXCLUDED.width,
        height = EXCLUDED.height,
        bytes = EXCLUDED.bytes,
        billable = EXCLUDED.billable
    `;

    logger.info({ ...logCtx, posterWidth, posterHeight }, 'Poster frame generated');
  } finally {
    await rm(tmpInput, { force: true }).catch(() => {});
    await rm(tmpOutput, { force: true }).catch(() => {});
  }
}
