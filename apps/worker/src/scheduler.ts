import { getConfig } from '@medialocker/config';
import { usageRollupQueue, billingReconcileQueue, secretRotateQueue, usageEventsConsumerQueue, storageReconcileQueue } from './queues';
import { logger } from './logger';

const connection = { url: getConfig().REDIS_URL };

export async function startScheduler(): Promise<void> {

  await usageRollupQueue.add(
    'usage:rollup',
    { type: 'periodic' },
    {
      repeat: { every: 15 * 60 * 1000 },
      jobId: 'usage:rollup:periodic',
    },
  );

  await usageEventsConsumerQueue.add(
    'usage:events:consume',
    { type: 'periodic' },
    {
      repeat: { every: 30 * 1000 },
      jobId: 'usage:events:consume:periodic',
    },
  );

  await billingReconcileQueue.add(
    'billing:reconcile',
    { type: 'nightly' },
    {
      repeat: {
        pattern: '0 3 * * *',
      },
      jobId: 'billing:reconcile:nightly',
    },
  );

  await secretRotateQueue.add(
    'secret:rotate',
    { type: 'scheduled' },
    {
      repeat: {
        pattern: '0 4 * * *',
      },
      jobId: 'secret:rotate:daily',
    },
  );

  await storageReconcileQueue.add(
    'storage:reconcile',
    { type: 'nightly' },
    {
      repeat: {
        pattern: '0 2 * * *',
      },
      jobId: 'storage:reconcile:nightly',
    },
  );

  logger.info(
    {},
    'Scheduler started — usage:events:consume every 30s, usage:rollup every 15m, storage:reconcile nightly at 2am, billing:reconcile nightly at 3am, secret:rotate daily at 4am',
  );
}
