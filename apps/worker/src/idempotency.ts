import type { Job } from 'bullmq';
import Redis from 'ioredis';
import { getConfig } from '@medialocker/config';
import {
  idempotentHandler,
  type RawHandler,
  type StorageAdapter,
} from '@reaatech/idempotency-middleware';
import { RedisAdapter } from '@reaatech/idempotency-middleware-adapter-redis';
import { logger } from './logger';

// Job idempotency records live long enough to cover BullMQ retry/redelivery
// windows. 24h matches the upload idempotency TTL.
const TTL_MS = 60 * 60 * 24 * 1000;

let redis: Redis | null = null;
let adapter: StorageAdapter | null = null;
let connected: Promise<void> | null = null;

function getAdapter(): StorageAdapter {
  if (adapter) return adapter;
  redis = new Redis(getConfig().REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
  adapter = new RedisAdapter(redis);
  return adapter;
}

async function ensureConnected(): Promise<StorageAdapter> {
  const a = getAdapter();
  if (!connected) {
    connected = a.connect().catch((err) => {
      connected = null;
      throw err;
    });
  }
  await connected;
  return a;
}

/**
 * Derive a stable idempotency key for a BullMQ job. Prefers a domain key on the
 * payload (`idempotencyKey`) when present, otherwise falls back to the BullMQ
 * job id. The queue name scopes the key so the same id across queues never
 * collides.
 */
function jobKey(queue: string, job: Job): string {
  const domainKey = (job.data as { idempotencyKey?: string } | undefined)
    ?.idempotencyKey;
  return `job:${queue}:${domainKey ?? job.id ?? 'unknown'}`;
}

/**
 * Wrap a side-effecting BullMQ processor so a redelivered/retried job with the
 * same identity does not re-apply its side effects (e.g. double-counting usage
 * or re-mutating billing rows). The first run executes and its result is
 * cached; subsequent runs with the same key return the cached result without
 * re-executing.
 *
 * Fail-open: if Redis is unavailable we run the processor directly rather than
 * dropping the job. This matches the codebase's existing best-effort posture
 * toward Redis and avoids a Redis blip stalling all billing/usage processing.
 * The trade-off (a redelivery during a Redis outage could double-apply) is
 * acceptable for these low-frequency, drift-correcting jobs and is the same
 * exposure the previous code had with no idempotency at all.
 */
export function withJobIdempotency<TData>(
  queue: string,
  processor: (job: Job<TData>) => Promise<void>,
): (job: Job<TData>) => Promise<void> {
  return async (job: Job<TData>): Promise<void> => {
    let storage: StorageAdapter;
    try {
      storage = await ensureConnected();
    } catch (err) {
      logger.warn(
        { queue, jobId: job.id, error: String(err) },
        'Idempotency store unavailable — running job without idempotency',
      );
      await processor(job);
      return;
    }

    const handler: RawHandler<Job<TData>, void> = async (input) => {
      await processor(input);
    };
    // Dedup must rely solely on the explicit job key. The default
    // `includeBodyInKey: true` would fold a hash of the *entire job object*
    // into the cache key — and a redelivery/retry carries a different BullMQ
    // job id (and attempt metadata) for the SAME domain identity, which would
    // produce a different key and silently defeat idempotency. Disable it.
    const wrapped = idempotentHandler(storage, handler, {
      ttl: TTL_MS,
      includeBodyInKey: false,
      // (§P1) Do NOT cache failures. The library default `shouldCache: () => true`
      // caches a thrown error and replays it for the whole TTL (24h), so a job
      // that fails once would be permanently "poisoned": every BullMQ retry would
      // hit the cached error and never re-execute, silently defeating the retry/
      // backoff policy. Only cache successful results (so a redelivery is still a
      // no-op on success); let failures fall through so retries actually re-run.
      shouldCache: (response: unknown) => !(response instanceof Error),
    });

    await wrapped(job, jobKey(queue, job), {
      method: 'JOB',
      path: `/${queue}`,
    });
  };
}

export async function closeIdempotency(): Promise<void> {
  if (adapter) {
    try {
      await adapter.disconnect();
    } catch {
      // best-effort
    }
  }
  adapter = null;
  redis = null;
  connected = null;
}
