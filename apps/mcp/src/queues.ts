/**
 * BullMQ producers for the MCP server. The MCP edge only ENQUEUES jobs that the
 * worker (apps/worker) consumes — it never runs processors itself. Lazily
 * constructed from the request config's REDIS_URL.
 */
import { Queue } from "bullmq";

let variantQueue: Queue | null = null;
let cachedUrl: string | null = null;

export function getVariantQueue(redisUrl: string): Queue {
  if (!variantQueue || cachedUrl !== redisUrl) {
    variantQueue = new Queue("media:variant", {
      connection: { url: redisUrl },
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { age: 7 * 86400 },
        removeOnFail: { age: 30 * 86400 },
      },
    });
    cachedUrl = redisUrl;
  }
  return variantQueue;
}

export async function closeQueues() {
  if (variantQueue) {
    await variantQueue.close().catch(() => undefined);
    variantQueue = null;
    cachedUrl = null;
  }
}
