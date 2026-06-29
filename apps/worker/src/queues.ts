import { Queue, type JobsOptions } from 'bullmq';
import { getConfig } from '@medialocker/config';

const connection = { url: getConfig().REDIS_URL };

// Retry with exponential backoff, then retain exhausted jobs for 7 days so the
// BullMQ "failed" set acts as a dead-letter queue for inspection/replay. Media
// processors are idempotent (deterministic derivative keys), so retries are safe.
const mediaJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 86400 },
};

// Scheduled maintenance jobs: fewer attempts (the next scheduled run also retries
// the work), failed jobs retained for inspection.
const scheduledJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 3600, count: 100 },
  removeOnFail: { age: 7 * 86400 },
};

export const probeQueue = new Queue('media:probe', { connection, defaultJobOptions: mediaJobOptions });
export const thumbnailQueue = new Queue('media:thumbnail', { connection, defaultJobOptions: mediaJobOptions });
export const posterQueue = new Queue('media:poster', { connection, defaultJobOptions: mediaJobOptions });
export const spriteQueue = new Queue('media:sprite', { connection, defaultJobOptions: mediaJobOptions });
export const variantQueue = new Queue('media:variant', { connection, defaultJobOptions: mediaJobOptions });
export const usageRollupQueue = new Queue('usage:rollup', { connection, defaultJobOptions: scheduledJobOptions });
export const usageEventsConsumerQueue = new Queue('usage:events:consume', { connection, defaultJobOptions: scheduledJobOptions });
export const billingReconcileQueue = new Queue('billing:reconcile', { connection, defaultJobOptions: scheduledJobOptions });
export const secretRotateQueue = new Queue('secret:rotate', { connection, defaultJobOptions: scheduledJobOptions });
export const storageReconcileQueue = new Queue('storage:reconcile', { connection, defaultJobOptions: scheduledJobOptions });

export async function closeQueues(): Promise<void> {
  await Promise.all([
    probeQueue.close(),
    thumbnailQueue.close(),
    posterQueue.close(),
    spriteQueue.close(),
    variantQueue.close(),
    usageRollupQueue.close(),
    usageEventsConsumerQueue.close(),
    billingReconcileQueue.close(),
    secretRotateQueue.close(),
    storageReconcileQueue.close(),
  ]);
}
