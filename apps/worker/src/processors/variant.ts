import type { Job } from 'bullmq';
import { z } from 'zod';
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import { runFfmpeg } from '../ffmpeg';
import { unlink, stat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { MediaKind } from '@medialocker/media';
import { reserveCapacity, releaseCapacity } from '@medialocker/core';
import { autoAddCapacity } from '@medialocker/billing';
import { getDb } from '../db';
import type { Sql } from '../db';
import { getS3, refreshS3Client, DERIVED_BUCKET, streamObjectToFile } from '../s3';
import { logger } from '../logger';

export interface VariantJobData {
  objectId: string;
  orgId: string;
  setItemId: string;
  minioBucket: string;
  key: string;
  kind: MediaKind;
  targetWidth: number;
  targetHeight: number;
  aspectRatio: string;
  format?: string;
}

export const VariantJobSchema = z.object({
  objectId: z.string(),
  orgId: z.string(),
  setItemId: z.string(),
  minioBucket: z.string(),
  key: z.string(),
  kind: z.string(),
  targetWidth: z.number().positive(),
  targetHeight: z.number().positive(),
  aspectRatio: z.string(),
  format: z.string().optional(),
});

export async function processVariantJob(job: Job<VariantJobData>): Promise<void> {
  const data = VariantJobSchema.parse(job.data);
  const {
    objectId,
    orgId,
    setItemId,
    minioBucket,
    key,
    kind,
    targetWidth,
    targetHeight,
    aspectRatio,
    format,
  } = data;
  const logCtx = {
    objectId,
    orgId,
    setItemId,
    aspectRatio,
    targetWidth,
    targetHeight,
    jobId: job.id,
  };

  logger.info(logCtx, 'Generating variant');

  await refreshS3Client(); // §5: pick up a rotated MinIO secret (fail-safe no-op otherwise)
  const s3 = getS3();
  const db = getDb();

  let outputBuffer: Buffer | null = null;
  let outputPath: string | null = null;
  let outWidth!: number;
  let outHeight!: number;
  let variantBytes: number = 0;
  let contentType!: string;
  // Honor the requested output format where supported, defaulting per media kind.
  const requestedFormat = format?.toLowerCase();

  let tempPath: string | null = null;
  try {
    tempPath = join(tmpdir(), `ml-var-src-${randomUUID()}`);
    const srcPath = tempPath;
    const response = await s3.send(new GetObjectCommand({ Bucket: minioBucket, Key: key }));
    await streamObjectToFile(response.Body, srcPath);

    if (kind === MediaKind.Image) {
      const f = requestedFormat ?? 'jpeg';
      const imgOutputPath = join(tmpdir(), `ml-var-img-${randomUUID()}`);
      let pipeline = sharp(srcPath).resize(targetWidth, targetHeight, {
        fit: 'inside',
        withoutEnlargement: true,
      });
      switch (f) {
        case 'jpg':
        case 'jpeg':
          pipeline = pipeline.jpeg({ quality: 85 });
          contentType = 'image/jpeg';
          break;
        case 'png':
          pipeline = pipeline.png();
          contentType = 'image/png';
          break;
        case 'webp':
          pipeline = pipeline.webp({ quality: 85 });
          contentType = 'image/webp';
          break;
        case 'avif':
          pipeline = pipeline.avif({ quality: 60 });
          contentType = 'image/avif';
          break;
        default:
          throw new Error(`Unsupported image variant format: ${f}`);
      }
      await pipeline.toFile(imgOutputPath);
      const imgStats = await stat(imgOutputPath);
      variantBytes = imgStats.size;
      outputPath = imgOutputPath;
      outputBuffer = null;

      const outMeta = await sharp(imgOutputPath).metadata();
      outWidth = outMeta.width || targetWidth;
      outHeight = outMeta.height || targetHeight;
    } else if (kind === MediaKind.Video) {
      const f = requestedFormat ?? 'mp4';
      let ext: string;
      let outputOptions: string[];
      if (f === 'mp4') {
        ext = 'mp4';
        contentType = 'video/mp4';
        outputOptions = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'];
      } else if (f === 'webm') {
        ext = 'webm';
        contentType = 'video/webm';
        outputOptions = ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus', '-b:a', '128k'];
      } else {
        throw new Error(`Unsupported video variant format: ${format}`);
      }

      const tmpOutput = join(tmpdir(), `ml-var-out-${randomUUID()}.${ext}`);

      try {
        await runFfmpeg(
          ffmpeg(srcPath)
            .size(`${targetWidth}x${targetHeight}`)
            .outputOptions(outputOptions)
            .output(tmpOutput),
          { timeoutMs: 30 * 60 * 1000, logCtx },
        );

        const stats = await stat(tmpOutput);
        variantBytes = stats.size;
        outputPath = tmpOutput;

        try {
          const probeOut = execSync(
            `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${tmpOutput}"`,
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
          ).trim();
          const dims = probeOut.split(',');
          outWidth = parseInt(dims[0] || '', 10) || targetWidth;
          outHeight = parseInt(dims[1] || '', 10) || targetHeight;
        } catch {
          outWidth = targetWidth;
          outHeight = targetHeight;
        }
      } catch (err: unknown) {
        if (outputPath) {
          await unlink(outputPath).catch(() => {});
          outputPath = null;
        }
        throw err;
      }
    } else if (kind === MediaKind.Audio) {
      const f = requestedFormat ?? 'ogg';
      let ext: string;
      let applyCodec: (cmd: ffmpeg.FfmpegCommand) => ffmpeg.FfmpegCommand;
      if (f === 'ogg') {
        ext = 'ogg';
        contentType = 'audio/ogg';
        applyCodec = (cmd) => cmd.audioCodec('libvorbis').audioBitrate('128k');
      } else if (f === 'mp3') {
        ext = 'mp3';
        contentType = 'audio/mpeg';
        applyCodec = (cmd) => cmd.audioCodec('libmp3lame').audioBitrate('192k');
      } else {
        throw new Error(`Unsupported audio variant format: ${format}`);
      }

      const tmpOutput = join(tmpdir(), `ml-var-out-${randomUUID()}.${ext}`);

      try {
        await runFfmpeg(
          applyCodec(ffmpeg(srcPath))
            .output(tmpOutput),
          { timeoutMs: 30 * 60 * 1000, logCtx },
        );

        const stats = await stat(tmpOutput);
        variantBytes = stats.size;
        outputPath = tmpOutput;
        outWidth = 0;
        outHeight = 0;
      } catch (err: unknown) {
        if (outputPath) {
          await unlink(outputPath).catch(() => {});
          outputPath = null;
        }
        throw err;
      }
    } else {
      logger.warn(logCtx, 'Variant generation not supported for this media kind — copying original');
      const s = await stat(srcPath);
      variantBytes = s.size;
      outputPath = srcPath;
      outWidth = targetWidth;
      outHeight = targetHeight;
      contentType = 'application/octet-stream';
      tempPath = null;
    }
  } finally {
    if (tempPath && tempPath !== outputPath) {
      try { await rm(tempPath, { force: true }).catch(() => {}); } catch { /* best-effort */ }
    }
  }

  const variantKey = `${orgId}/${objectId}/variant/${aspectRatio}`;

  // Reserve + record atomically BEFORE uploading to MinIO, so a quota failure
  // never leaves orphaned bytes in storage. The derivative row is the ledger:
  // on a clean retry priorBytes == variantBytes → delta 0 → nothing re-reserved
  // or re-emitted; a failed attempt rolls the whole transaction back so no bytes
  // leak. (§24 quota safety carried into the variant path.)
  const recordVariant = (): Promise<void> =>
    db.begin(async (tx) => {
    const existing = await tx<{ bytes: string }[]>`
      SELECT bytes FROM derivatives
       WHERE object_id = ${objectId} AND type = 'variant' AND minio_key = ${variantKey}
       LIMIT 1
       FOR UPDATE
    `;
    const priorBytes = existing.length > 0 ? BigInt(existing[0]!.bytes) : BigInt(0);
    const deltaBytes = BigInt(variantBytes) - priorBytes;

    if (deltaBytes > BigInt(0)) {
      const reserved = await reserveCapacity(tx as unknown as Sql, orgId, deltaBytes);
      if (!reserved.success) {
        logger.error(logCtx, 'Insufficient capacity for variant — quota exceeded');
        throw new Error('InsufficientStorage: capacity exceeded for variant generation');
      }
    } else if (deltaBytes < BigInt(0)) {
      await releaseCapacity(tx as unknown as Sql, orgId, -deltaBytes);
    }

    await tx`
      INSERT INTO derivatives (object_id, type, minio_key, width, height, bytes, billable)
      VALUES (${objectId}, 'variant', ${variantKey}, ${outWidth}, ${outHeight}, ${variantBytes}, true)
      ON CONFLICT (object_id, type, minio_key) DO UPDATE SET
        width = EXCLUDED.width,
        height = EXCLUDED.height,
        bytes = EXCLUDED.bytes,
        billable = EXCLUDED.billable
    `;

    if (deltaBytes !== BigInt(0)) {
      await tx`
        INSERT INTO usage_events (org_id, type, bytes, ts)
        VALUES (${orgId}, 'stored_delta', ${String(deltaBytes)}::bigint, now())
      `;
    }

    await tx`
      UPDATE set_items
         SET width = ${outWidth}, height = ${outHeight}, aspect_ratio = ${aspectRatio}
       WHERE id = ${setItemId}
         AND set_id IN (SELECT id FROM sets WHERE org_id = ${orgId})
    `;
    });

  try {
    await recordVariant();
  } catch (err) {
    const overQuota = err instanceof Error && err.message.includes('InsufficientStorage');
    if (overQuota) {
      logger.warn(logCtx, 'Variant over quota — attempting auto-capacity');
      const added = await autoAddCapacity(db, orgId);
      if (added.added) {
        try {
          await recordVariant();
        } catch {
          /* still over quota — propagate */
          throw err;
        }
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  // Upload only after successful reservation (`variantKey` is deterministic,
  // so a retry overwrites the same object idempotently at the storage layer).
  //
  // P2.34: the derivative row + capacity reservation are now COMMITTED. If the
  // upload fails permanently (retries exhausted) we'd be left with reserved bytes
  // and a ledger row pointing at an object that never landed in MinIO — an
  // orphaned derivative. On the LAST attempt, compensate: delete the orphaned
  // derivative row, release the reserved bytes (with a balancing stored_delta
  // event), and best-effort delete any partially-uploaded object. The output temp
  // file is unlinked in `finally` regardless of success/failure (P2.35).
  const attempts = (job as { opts?: { attempts?: number } }).opts?.attempts ?? 1;
  const attemptsMade = (job as { attemptsMade?: number }).attemptsMade ?? 0;
  const isFinalAttempt = attemptsMade + 1 >= attempts;

  try {
    if (outputPath) {
      const upload = new Upload({
        client: s3,
        params: {
          Bucket: DERIVED_BUCKET,
          Key: variantKey,
          Body: createReadStream(outputPath),
          ContentType: contentType,
        },
      });
      await upload.done();
    } else {
      await s3.send(
        new PutObjectCommand({
          Bucket: DERIVED_BUCKET,
          Key: variantKey,
          Body: outputBuffer!,
          ContentType: contentType,
        }),
      );
    }
  } catch (uploadErr) {
    if (isFinalAttempt) {
      logger.error(
        { ...logCtx, error: String(uploadErr) },
        'Variant upload failed on final attempt — rolling back orphaned derivative + reservation',
      );
      try {
        await db.begin(async (tx) => {
          const removed = await tx<{ bytes: string; billable: boolean }[]>`
            DELETE FROM derivatives
             WHERE object_id = ${objectId} AND type = 'variant' AND minio_key = ${variantKey}
            RETURNING bytes, billable
          `;
          const row = removed[0];
          if (row && row.billable) {
            const releaseBytes = BigInt(row.bytes);
            if (releaseBytes > BigInt(0)) {
              await releaseCapacity(tx as unknown as Sql, orgId, releaseBytes);
              await tx`
                INSERT INTO usage_events (org_id, type, bytes, ts)
                VALUES (${orgId}, 'stored_delta', ${String(-releaseBytes)}::bigint, now())
              `;
            }
          }
        });
        // Best-effort: remove any partially-written object so storage matches the
        // now-deleted ledger row.
        await s3
          .send(new DeleteObjectCommand({ Bucket: DERIVED_BUCKET, Key: variantKey }))
          .catch(() => {});
      } catch (cleanupErr) {
        logger.error(
          { ...logCtx, error: String(cleanupErr) },
          'Variant rollback failed — manual reconcile may be required',
        );
      }
    }
    throw uploadErr;
  } finally {
    if (outputPath) {
      await unlink(outputPath).catch(() => {});
    }
  }

  logger.info({ ...logCtx, variantBytes, outWidth, outHeight }, 'Variant generated and reserved');
}
