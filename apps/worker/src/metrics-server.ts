import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Queue } from 'bullmq';
import {
  probeQueue,
  thumbnailQueue,
  posterQueue,
  spriteQueue,
  variantQueue,
  usageRollupQueue,
  usageEventsConsumerQueue,
  billingReconcileQueue,
  secretRotateQueue,
} from './queues';
import {
  JOB_STATES,
  renderPrometheus,
  renderDashboard,
  type QueueCounts,
} from './metrics-format';
import { logger } from './logger';

// P3.11: Centralized worker metrics + BullMQ dashboard.
//
// The worker is otherwise a headless BullMQ consumer with no HTTP surface, so
// operators had zero queue-depth / worker-lag visibility. This adds a small
// dependency-free HTTP server exposing:
//   GET /health        — liveness (always open, used by the container healthcheck)
//   GET /metrics       — Prometheus text exposition of per-queue job counts
//   GET /admin/queues  — live HTML dashboard of every queue's job states
//
// SECURITY: this is an operations/admin surface. Per P1.50 (admin surfaces must
// not be public) it binds to the internal network only and is NEVER given a
// public Caddy route. /metrics and /admin/queues additionally require a bearer
// token when WORKER_METRICS_TOKEN is set. /health stays open for healthchecks.

const ALL_QUEUES: ReadonlyArray<Queue> = [
  probeQueue,
  thumbnailQueue,
  posterQueue,
  spriteQueue,
  variantQueue,
  usageRollupQueue,
  usageEventsConsumerQueue,
  billingReconcileQueue,
  secretRotateQueue,
];

async function collectCounts(): Promise<QueueCounts[]> {
  return Promise.all(
    ALL_QUEUES.map(async (q) => {
      const counts = (await q.getJobCounts(...JOB_STATES)) as Record<string, number>;
      return { queue: q.name, counts };
    }),
  );
}

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true; // no token configured → internal-network trust only
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const expected = `Bearer ${token}`;
  // length check first avoids a needless compare; not timing-sensitive (admin LAN surface)
  return header.length === expected.length && header === expected;
}

let server: Server | null = null;

export function startMetricsServer(): Server | null {
  if (process.env['WORKER_METRICS_ENABLED'] === 'false') {
    logger.info({}, 'Worker metrics server disabled (WORKER_METRICS_ENABLED=false)');
    return null;
  }
  const port = Number(process.env['WORKER_METRICS_PORT'] ?? 9090);
  const host = process.env['WORKER_METRICS_HOST'] ?? '0.0.0.0';
  const token = process.env['WORKER_METRICS_TOKEN'] || undefined;

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? '/').split('?')[0];

    if (url === '/health' || url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }

    if (url === '/metrics' || url === '/admin/queues' || url === '/admin/queues/') {
      if (!authorized(req, token)) {
        res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Bearer' });
        res.end('Unauthorized');
        return;
      }
      collectCounts()
        .then((snapshot) => {
          if (url === '/metrics') {
            res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
            res.end(renderPrometheus(snapshot));
          } else {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(renderDashboard(snapshot));
          }
        })
        .catch((err: unknown) => {
          logger.error({ error: String(err) }, 'metrics collection failed');
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('metrics unavailable');
        });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  });

  server.on('error', (err) => {
    logger.error({ error: String(err) }, 'Worker metrics server error');
  });

  server.listen(port, host, () => {
    logger.info({ host, port, authRequired: Boolean(token) }, 'Worker metrics server listening (internal only)');
  });

  return server;
}

export async function stopMetricsServer(): Promise<void> {
  const s = server;
  if (!s) return;
  server = null;
  await new Promise<void>((resolve) => s.close(() => resolve()));
}
