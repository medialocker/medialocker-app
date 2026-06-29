import "./instrumentation.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { getConfig, getTrustedProxyCidrs } from "@medialocker/config";
import { createLogger, shutdownTelemetry } from "@medialocker/observability";
import postgres from "postgres";
import { authMiddleware } from "./middleware/auth.js";
import { validationHook } from "./middleware/validation.js";
import { idempotencyPreHandler, idempotencyOnSend } from "./middleware/idempotency.js";
import { authRoutes } from "./routes/auth.js";
import { bucketRoutes } from "./routes/buckets.js";
import { mediaRoutes } from "./routes/media.js";
import { tagRoutes } from "./routes/tags.js";
import { categoryRoutes } from "./routes/categories.js";
import { setRoutes } from "./routes/sets.js";
import { storyboardRoutes } from "./routes/storyboards.js";
import { searchRoutes } from "./routes/search.js";
import { usageRoutes } from "./routes/usage.js";
import { presignRoutes } from "./routes/presign.js";
import { webhookRoutes } from "./routes/webhook.js";
import { openapiRoutes } from "./openapi.js";

const logger = createLogger("api");

const cfg = getConfig();

const sql = postgres(cfg.DATABASE_URL, {
  // Supabase Cloud transaction pooler (6543): prepared statements are
  // unsupported there, so disable them. TLS via the connection string
  // (`?sslmode=require`). Pool sized to stay within the project's pooler budget.
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  prepare: false,
});

// INTERNAL TLS (§8.4): in-cluster traffic to Redis flows over the internal Docker
// bridge network and is NOT encrypted at the transport layer (confined to the
// host). Postgres + Auth (Supabase Cloud) and object storage (Hetzner) are
// external and reached over the public network WITH TLS (sslmode=require / HTTPS).
// If inter-host bridge communication is ever needed, add mTLS or a service mesh
// (e.g. Consul Connect / Istio) before exposing the internal network beyond a node.

const server = Fastify({
  logger: true,
  bodyLimit: 5 * 1024 * 1024,
  // Only trust X-Forwarded-* from the internal Docker network (where Caddy
  // terminates TLS and proxies in). An unbounded `trustProxy: true` lets any
  // client spoof their IP via the header, defeating the rate-limit IP fallback.
  // In non-production (direct local runs, no proxy) trust the loopback default.
  trustProxy: getTrustedProxyCidrs(),
});

// Per-request access to the shared pool/config. These must be request
// decorations (not instance decorations) because every route handler and the
// auth middleware read `request.sql` / `request.config`. Decorate with a null
// default and assign the shared (immutable) references in the first onRequest
// hook so they are populated before auth runs.
server.decorateRequest("sql", null as never);
server.decorateRequest("config", null as never);

server.addHook("onRequest", async (request) => {
  request.sql = sql;
  request.config = cfg;
});

server.addHook("onRequest", validationHook);

// Centralized error handler: log the real error server-side, but never leak
// stack traces / internal messages to clients. Preserves explicit 4xx statuses
// and Fastify validation errors; everything else is a generic 500.
server.setErrorHandler((err: import("fastify").FastifyError, request, reply) => {
  const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
  if (status >= 500) {
    logger.error({ err, path: request.url, method: request.method }, "Unhandled request error");
  }
  void reply.status(status).send({
    error: {
      code: status === 500 ? "InternalError" : (err.code ?? "BadRequest"),
      message: status === 500 ? "An internal error occurred." : err.message,
    },
  });
});

server.addHook("onRequest", async (request, reply) => {
  const openPaths = [
    "/api/stripe/webhook",
    "/api/openapi.json",
    "/api/health",
    "/api/plans",
  ];
  const path = request.url.split("?")[0]!;
  if (openPaths.includes(path)) return;
  if (path.startsWith("/api/")) {
    await authMiddleware(request, reply);
  }
});

// Idempotency for mutating routes (runs after auth). Replays a stored response
// when a repeated Idempotency-Key is seen; onSend persists successful responses.
server.addHook("onRequest", idempotencyPreHandler);
server.addHook("onSend", idempotencyOnSend);

await server.register(cors, {
  origin: [
    `https://app.${cfg.PUBLIC_BASE_DOMAIN}`,
    `https://${cfg.PUBLIC_BASE_DOMAIN}`,
    `https://mcp.${cfg.PUBLIC_BASE_DOMAIN}`,
  ],
  credentials: true,
});

// P2.19: build the rate-limit options with a shared Redis store, but NEVER let a
// Redis init failure crash boot. If the ioredis client can't be constructed
// (bad/unreachable REDIS_URL), fall back to @fastify/rate-limit's built-in
// in-memory store with a warning. In-memory limiting is per-process (not shared
// across replicas) but keeps the service up and still bounds abuse on each node.
const rateLimitBase = {
  max: 300,
  timeWindow: "1 minute",
  keyGenerator: (request: import("fastify").FastifyRequest) => {
    const auth = (request as any).auth;
    return auth?.orgId ?? request.ip;
  },
  errorResponseBuilder: (
    _request: import("fastify").FastifyRequest,
    context: { ttl?: number },
  ) => ({
    statusCode: 429,
    error: "Too Many Requests",
    message: `Rate limit exceeded, retry after ${Math.ceil((context.ttl ?? 0) / 1000)} seconds`,
  }),
};

let rateLimitRedis: import("ioredis").Redis | undefined;
try {
  const { default: IORedis } = await import("ioredis");
  // lazyConnect so a bad URL surfaces here as a construction error rather than an
  // unhandled async connection failure that would tear the process down later.
  rateLimitRedis = new IORedis(cfg.REDIS_URL, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  rateLimitRedis.on("error", (err) => {
    logger.warn({ err }, "Rate-limit Redis connection error (limiter continues, may degrade)");
  });
} catch (err) {
  logger.warn({ err }, "Failed to init rate-limit Redis store; falling back to in-memory rate limiting");
  rateLimitRedis = undefined;
}

await server.register(rateLimit, {
  ...rateLimitBase,
  ...(rateLimitRedis ? { redis: rateLimitRedis } : {}),
});

// Health check returns only liveness — no version/build info (avoid disclosing
// the exact deployed version to unauthenticated callers).
server.get("/api/health", async () => ({ status: "ok" }));

// Public plan catalog (§10.6) so external clients can drive tier metadata
// (included storage + per-GB add-on price) from the plans table instead of
// hardcoding it. No auth: pricing is public.
server.get("/api/plans", async (request) => {
  const rows = await request.sql<{
    tier_key: string;
    name: string;
    included_gb: string;
    per_gb_price_cents: number;
    stripe_price_id: string | null;
  }[]>`
    SELECT tier_key, name, included_gb, per_gb_price_cents, stripe_price_id
    FROM plans ORDER BY included_gb ASC
  `;
  return {
    plans: rows.map((p) => ({
      tierKey: p.tier_key,
      name: p.name,
      includedGb: Number(p.included_gb),
      perGbPriceCents: p.per_gb_price_cents,
      hasStripePrice: Boolean(p.stripe_price_id),
    })),
  };
});

await server.register(authRoutes, { prefix: "/api" });
await server.register(bucketRoutes, { prefix: "/api" });
await server.register(mediaRoutes, { prefix: "/api" });
await server.register(tagRoutes, { prefix: "/api" });
await server.register(categoryRoutes, { prefix: "/api" });
await server.register(setRoutes, { prefix: "/api" });
await server.register(storyboardRoutes, { prefix: "/api" });
await server.register(searchRoutes, { prefix: "/api" });
await server.register(usageRoutes, { prefix: "/api" });
await server.register(presignRoutes, { prefix: "/api" });
await server.register(webhookRoutes, { prefix: "/api" });
await server.register(openapiRoutes, { prefix: "/api" });

const port = parseInt(process.env["PORT"] ?? "3002", 10);

try {
  await server.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "API server started");
} catch (err) {
  logger.error({ err }, "Failed to start API server");
  process.exit(1);
}

const shutdown = async (signal: string) => {
  logger.info({ signal }, "API server shutting down");
  await server.close().catch(() => undefined);
  await sql.end({ timeout: 5 }).catch(() => undefined);
  await shutdownTelemetry().catch(() => undefined);
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { server, sql };
