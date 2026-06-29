import type { Job } from 'bullmq';
import { z } from 'zod';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import { runFfmpeg } from '../ffmpeg';
import { rm, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { getS3, refreshS3Client, DERIVED_BUCKET, streamObjectToFile } from '../s3';
import { logger } from '../logger';

export interface SpriteJobData {
  objectId: string;
  orgId: string;
  minioBucket: string;
  key: string;
  durationMs?: number;
  width?: number;
  height?: number;
}

export const SpriteJobSchema = z.object({
  objectId: z.string(),
  orgId: z.string(),
  minioBucket: z.string(),
  key: z.string(),
  durationMs: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

const SPRITE_COLUMNS = 10;
const SPRITE_FRAME_WIDTH = 160;

export async function processSpriteJob(job: Job<SpriteJobData>): Promise<void> {
  const data = SpriteJobSchema.parse(job.data);
  const { objectId, orgId, minioBucket, key, durationMs } = data;
  const logCtx = { objectId, orgId, key, jobId: job.id };

  logger.info(logCtx, 'Generating sprite strip');

  await refreshS3Client(); // §5: pick up a rotated MinIO secret (fail-safe no-op otherwise)
  const s3 = getS3();
  const db = getDb();

  const response = await s3.send(
    new GetObjectCommand({ Bucket: minioBucket, Key: key }),
  );

  const workDir = join(tmpdir(), `ml-sprite-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });

  // Stream the source straight to disk rather than buffering the whole (possibly
  // large) video in memory. §6.3
  const tmpInput = join(workDir, 'input');
  await streamObjectToFile(response.Body, tmpInput);

  const totalDurationSec = durationMs ? durationMs / 1000 : 10;

  try {
    // Extract all sprite frames in ONE ffmpeg pass via the fps filter, rather
    // than seeking + spawning ffmpeg once per frame. fps = columns / duration
    // yields ~SPRITE_COLUMNS evenly spaced frames; -frames:v caps the count.
    const fps = SPRITE_COLUMNS / totalDurationSec;
    await runFfmpeg(
      ffmpeg(tmpInput)
        .outputOptions(['-vf', `fps=${fps}`, '-frames:v', String(SPRITE_COLUMNS), '-q:v', '3'])
        .output(join(workDir, 'frame-%03d.jpg')),
      { timeoutMs: 30 * 60 * 1000, logCtx },
    );

    // Collect whatever frames were produced (a short clip may yield fewer).
    const framePaths: string[] = [];
    for (let i = 1; i <= SPRITE_COLUMNS; i++) {
      const fp = join(workDir, `frame-${String(i).padStart(3, '0')}.jpg`);
      try {
        await access(fp);
        framePaths.push(fp);
      } catch {
        break;
      }
    }
    if (framePaths.length === 0) {
      throw new Error('ffmpeg produced no sprite frames');
    }

    // Resize each frame incrementally, reading straight from its on-disk path
    // (sharp streams the file itself — no `readFile` buffering the original JPEG
    // into the heap first). `-frames:v SPRITE_COLUMNS` already caps the count to a
    // small fixed bound, so the previous "large frame count may cause high memory
    // usage" warning was dead code and has been removed. (P2.39)
    const frameBuffers: Buffer[] = [];
    for (const fp of framePaths) {
      const resized = await sharp(fp)
        .resize(SPRITE_FRAME_WIDTH, undefined, { fit: 'inside' })
        .toBuffer();
      frameBuffers.push(resized);
    }

    const columns = frameBuffers.length;
    const frameMeta = await sharp(frameBuffers[0]!).metadata();
    const frameH = frameMeta.height || 90;
    const spriteWidth = SPRITE_FRAME_WIDTH * columns;

    const compositeImages = frameBuffers.map((buf, i) => ({
      input: buf,
      left: i * SPRITE_FRAME_WIDTH,
      top: 0,
    }));

    const spriteBuffer = await sharp({
      create: {
        width: spriteWidth,
        height: frameH,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .composite(compositeImages)
      .jpeg({ quality: 80 })
      .toBuffer();

    const derivativeKey = `${orgId}/${objectId}/sprite`;

    await s3.send(
      new PutObjectCommand({
        Bucket: DERIVED_BUCKET,
        Key: derivativeKey,
        Body: spriteBuffer,
        ContentType: 'image/jpeg',
      }),
    );

    await db`
      INSERT INTO derivatives (object_id, type, minio_key, width, height, bytes, billable)
      VALUES (${objectId}, 'sprite', ${derivativeKey}, ${spriteWidth}, ${frameH}, ${spriteBuffer.length}, false)
      ON CONFLICT (object_id, type, minio_key) DO UPDATE SET
        minio_key = EXCLUDED.minio_key,
        width = EXCLUDED.width,
        height = EXCLUDED.height,
        bytes = EXCLUDED.bytes,
        billable = EXCLUDED.billable
    `;

    logger.info({ ...logCtx, frames: columns }, 'Sprite strip generated');
  } finally {
    // Remove the whole working directory, not just the known frame files — the
    // single-pass extraction's output count is variable, so per-file unlinks
    // leaked temp data. (§6.5)
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
