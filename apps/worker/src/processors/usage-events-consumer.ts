import type { Job } from 'bullmq';
import Redis from 'ioredis';
import { getConfig } from '@medialocker/config';
import { getDb } from '../db';
import { logger } from '../logger';

export interface UsageEventsConsumerJobData {
  type: 'periodic';
}

const STREAM = 'usage:events';
const CONSUMER_GROUP = 'medialocker-worker';
const CONSUMER_NAME = 'worker-usage-events';
const BATCH_SIZE = 500;

function getRedis(): Redis {
  return new Redis(getConfig().REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });
}

export async function processUsageEventsConsumerJob(
  _job: Job<UsageEventsConsumerJobData>,
): Promise<void> {
  const redis = getRedis();
  const db = getDb();

  try {
    await redis
      .xgroup('CREATE', STREAM, CONSUMER_GROUP, '0-0', 'MKSTREAM')
      .catch((err: Error) => {
        if (!err.message.includes('BUSYGROUP')) throw err;
      });
  } catch (err) {
    logger.warn({ error: String(err) }, 'Failed to create Redis consumer group');
    redis.disconnect();
    return;
  }

  let processed = 0;
  for (;;) {
    const results = (await redis.xreadgroup(
      'GROUP',
      CONSUMER_GROUP,
      CONSUMER_NAME,
      'COUNT',
      BATCH_SIZE,
      'BLOCK',
      5000,
      'STREAMS',
      STREAM,
      '>',
    )) as [string, [string, string[]][]][] | null;

    if (!results || results.length === 0) break;

    const entries = results[0]?.[1] ?? [];

    for (const [msgId, fields] of entries) {
      const dataIdx = fields.indexOf('data');
      if (dataIdx < 0) {
        await redis.xack(STREAM, CONSUMER_GROUP, msgId);
        continue;
      }
      const raw = fields[dataIdx + 1];
      if (!raw) {
        await redis.xack(STREAM, CONSUMER_GROUP, msgId);
        continue;
      }

      try {
        const event = JSON.parse(raw);
        const eventType = String(event.type || '');
        const eventOrgId = String(event.org_id || '');
        const eventTs = String(event.ts || new Date().toISOString());

        if (!eventOrgId || !eventType) {
          await redis.xack(STREAM, CONSUMER_GROUP, msgId);
          continue;
        }

        let bytes = 0;
        if (eventType === 'egress' || eventType === 'stored_delta') {
          bytes =
            typeof event.bytes === 'string'
              ? parseInt(event.bytes, 10) || 0
              : Number(event.bytes) || 0;
        }

        await db`
          INSERT INTO usage_events (org_id, type, bytes, ts)
          VALUES (
            ${eventOrgId}::uuid,
            ${eventType}::usage_event_type,
            ${String(bytes)}::bigint,
            ${eventTs}::timestamptz
          )
        `;

        await redis.xack(STREAM, CONSUMER_GROUP, msgId);
        processed++;
      } catch (err) {
        logger.warn(
          { msgId, error: String(err) },
          'Failed to process usage event — skipping',
        );
        await redis.xack(STREAM, CONSUMER_GROUP, msgId).catch(() => {});
      }
    }
  }

  logger.info({ processed }, 'Usage events consumer batch complete');
  redis.disconnect();
}
