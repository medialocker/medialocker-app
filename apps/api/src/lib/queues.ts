/**
 * BullMQ producers for the control-plane API. The API only ENQUEUES jobs that the
 * worker (apps/worker) consumes — it never runs processors itself. Lazily
 * constructed from REDIS_URL. Mirrors apps/mcp/src/queues.ts.
 */
import { Queue } from "bullmq";
import { getConfig } from "@medialocker/config";

let variantQueue: Queue | null = null;
let probeQueue: Queue | null = null;
let cachedUrl: string | null = null;

const mediaJobOptions = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnFail: { age: 7 * 86400 },
};

export function getVariantQueue(): Queue {
  const redisUrl = getConfig().REDIS_URL;
  if (!variantQueue || cachedUrl !== redisUrl) {
    variantQueue = new Queue("media:variant", {
      connection: { url: redisUrl },
      // Retry transient failures + retain exhausted jobs as an inspectable DLQ,
      // matching the worker's media-queue policy. (M3)
      defaultJobOptions: mediaJobOptions,
    });
    cachedUrl = redisUrl;
  }
  return variantQueue;
}

/**
 * Producer for `media:probe`. Post-gateway, the upload-confirm endpoint
 * (§8.3) enqueues the probe here after writing the authoritative `objects` row,
 * so the worker generates derivatives + media metadata. Matches the worker's
 * queue name/options (apps/worker/src/queues.ts).
 */
export function getProbeQueue(): Queue {
  const redisUrl = getConfig().REDIS_URL;
  if (!probeQueue || cachedUrl !== redisUrl) {
    probeQueue = new Queue("media:probe", {
      connection: { url: redisUrl },
      defaultJobOptions: mediaJobOptions,
    });
    cachedUrl = redisUrl;
  }
  return probeQueue;
}
