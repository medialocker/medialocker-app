import './instrumentation';
import type { WorkerOptions } from 'bullmq';
import { Worker } from 'bullmq';

interface MLWorkerOptions extends WorkerOptions {
  defaultJobOptions?: {
    attempts?: number;
    backoff?: { type: string; delay: number };
    removeOnFail?: { age: number };
  };
}
import { execSync } from 'node:child_process';
import { getConfig } from '@medialocker/config';
import { shutdownTelemetry } from '@medialocker/observability';
import { processProbeJob } from './processors/probe';
import { processThumbnailJob } from './processors/thumbnail';
import { processPosterJob } from './processors/poster';
import { processSpriteJob } from './processors/sprite';
import { processVariantJob } from './processors/variant';
import { processUsageRollupJob } from './processors/usage-rollup';
import { processBillingReconcileJob } from './processors/billing-reconcile';
import { processSecretRotationJob } from './processors/secret-rotation';
import { processUsageEventsConsumerJob } from './processors/usage-events-consumer';
import { processStorageReconcileJob } from './processors/reconcile';
import { closeQueues } from './queues';
import { closeDb } from './db';
import { startScheduler } from './scheduler';
import { withJobIdempotency, closeIdempotency } from './idempotency';
import { runningFfmpegCommands } from './ffmpeg';
import { startMetricsServer, stopMetricsServer } from './metrics-server';
import { logger } from './logger';

const connection = { url: getConfig().REDIS_URL };

let probeWorker: Worker;
let thumbnailWorker: Worker;
let posterWorker: Worker;
let spriteWorker: Worker;
let variantWorker: Worker;
let usageRollupWorker: Worker;
let billingReconcileWorker: Worker;
let secretRotateWorker: Worker;
let usageEventsConsumerWorker: Worker;
let storageReconcileWorker: Worker;

async function main(): Promise<void> {
  logger.info({ nodeEnv: getConfig().NODE_ENV }, 'MediaLocker worker starting');

  // Verify external media tooling is available at startup so operators get a
  // clear warning rather than cryptic failures deep in media jobs.
  for (const tool of ['ffmpeg', 'ffprobe']) {
    try {
      execSync(`${tool} -version`, { stdio: 'ignore', timeout: 5000 });
      logger.info({ tool }, 'External tool found');
    } catch {
      logger.warn(
        { tool },
        `${tool} not found or not executable — media processing jobs requiring it will fail`,
      );
    }
  }

  probeWorker = new Worker('media-probe', processProbeJob, {
    connection,
    concurrency: 4,
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86400 },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnFail: { age: 7 * 86400 },
    },
  } as MLWorkerOptions);

  thumbnailWorker = new Worker('media-thumbnail', processThumbnailJob, {
    connection,
    concurrency: 2,
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86400 },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnFail: { age: 7 * 86400 },
    },
  } as MLWorkerOptions);

  posterWorker = new Worker('media-poster', processPosterJob, {
    connection,
    concurrency: 2,
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86400 },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnFail: { age: 7 * 86400 },
    },
  } as MLWorkerOptions);

  spriteWorker = new Worker('media-sprite', processSpriteJob, {
    connection,
    concurrency: 1,
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86400 },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnFail: { age: 7 * 86400 },
    },
  } as MLWorkerOptions);

  variantWorker = new Worker('media-variant', processVariantJob, {
    connection,
    concurrency: 2,
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86400 },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnFail: { age: 7 * 86400 },
    },
  } as MLWorkerOptions);

  usageRollupWorker = new Worker(
    'usage-rollup',
    withJobIdempotency('usage-rollup', processUsageRollupJob),
    {
      connection,
      concurrency: 1,
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnFail: { age: 7 * 86400 },
      },
    } as MLWorkerOptions,
  );

  billingReconcileWorker = new Worker(
    'billing-reconcile',
    withJobIdempotency('billing-reconcile', processBillingReconcileJob),
    {
      connection,
      concurrency: 1,
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnFail: { age: 7 * 86400 },
      },
    } as MLWorkerOptions,
  );

  secretRotateWorker = new Worker('secret-rotate', processSecretRotationJob, {
    connection,
    concurrency: 1,
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86400 },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnFail: { age: 7 * 86400 },
    },
  } as MLWorkerOptions);

  usageEventsConsumerWorker = new Worker(
    'usage-events-consume',
    processUsageEventsConsumerJob,
    {
      connection,
      concurrency: 1,
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnFail: { age: 7 * 86400 },
      },
    } as MLWorkerOptions,
  );

  storageReconcileWorker = new Worker(
    'storage-reconcile',
    withJobIdempotency('storage-reconcile', processStorageReconcileJob),
    {
      connection,
      concurrency: 1,
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnFail: { age: 7 * 86400 },
      },
    } as MLWorkerOptions,
  );

  storageReconcileWorker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, queue: 'storage-reconcile', error: err.message },
      'Job failed',
    );
  });

  secretRotateWorker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, queue: 'secret-rotate', error: err.message },
      'Job failed',
    );
  });

  probeWorker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, queue: 'media-probe', error: err.message },
      'Job failed',
    );
  });

  thumbnailWorker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, queue: 'media-thumbnail', error: err.message },
      'Job failed',
    );
  });

  variantWorker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, queue: 'media-variant', error: err.message },
      'Job failed',
    );
  });

  posterWorker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, queue: 'media-poster', error: err.message },
      'Job failed',
    );
  });

  spriteWorker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, queue: 'media-sprite', error: err.message },
      'Job failed',
    );
  });

  usageRollupWorker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, queue: 'usage-rollup', error: err.message },
      'Job failed',
    );
  });

  billingReconcileWorker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, queue: 'billing-reconcile', error: err.message },
      'Job failed',
    );
  });

  usageEventsConsumerWorker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, queue: 'usage-events-consume', error: err.message },
      'Job failed',
    );
  });

  await startScheduler();

  // P3.11: internal-only metrics + BullMQ dashboard (queue depth / worker lag).
  startMetricsServer();

  logger.info({}, 'MediaLocker worker ready — all queues listening');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Worker shutting down');

    const shutdownTimeoutMs = 30_000;
    let forceExitTimer: ReturnType<typeof setTimeout> | null = null;

    const forceShutdown = () => {
      logger.warn({}, 'Graceful shutdown timed out — killing remaining ffmpeg children');
      for (const cmd of runningFfmpegCommands) {
        try { cmd.kill('SIGKILL'); } catch { /* best-effort */ }
      }
      runningFfmpegCommands.clear();
      process.exit(1);
    };

    forceExitTimer = setTimeout(forceShutdown, shutdownTimeoutMs);

    try {
      await Promise.all([
        probeWorker.close(),
        thumbnailWorker.close(),
        posterWorker.close(),
        spriteWorker.close(),
        variantWorker.close(),
        usageRollupWorker.close(),
        billingReconcileWorker.close(),
        secretRotateWorker.close(),
        usageEventsConsumerWorker.close(),
        storageReconcileWorker.close(),
      ]);

      await stopMetricsServer();
      await closeQueues();
      await closeIdempotency();
      await closeDb();
      await shutdownTelemetry();

      if (forceExitTimer) clearTimeout(forceExitTimer);
      logger.info({}, 'Worker shutdown complete');
      process.exit(0);
    } catch (err) {
      if (forceExitTimer) clearTimeout(forceExitTimer);
      logger.error({ error: String(err) }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ error: String(err) }, 'Worker failed to start');
  process.exit(1);
});
