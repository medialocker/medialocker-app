import type { FastifyRequest, FastifyReply } from "fastify";
import { getConfig } from "@medialocker/config";
import Redis from "ioredis";
import {
  generateCacheKey,
  type IdempotencyRecord,
  type StorageAdapter,
} from "@reaatech/idempotency-middleware";
import { RedisAdapter } from "@reaatech/idempotency-middleware-adapter-redis";

// Idempotency for mutating control-plane routes (§9.7). Clients that supply an
// `Idempotency-Key` header on a POST/PUT/DELETE/PATCH get exactly-once semantics:
// a retry with the same key + method + path replays the stored response instead
// of re-running the mutation. Requests WITHOUT the header are untouched (no redis
// round-trip), and the Stripe webhook never sends the header so it is unaffected.
// Fail-open: any redis error skips idempotency rather than failing the request.

const TTL_MS = 60 * 60 * 24 * 1000;
const MUTATING = new Set(["POST", "PUT", "DELETE", "PATCH"]);

// P2.20: paths that must NEVER go through idempotency handling, regardless of
// any client-supplied Idempotency-Key header. The Stripe webhook is
// UNAUTHENTICATED (no request.auth), so the per-principal vary headers below
// would key every event under the same empty principal — and Stripe already
// guarantees at-least-once delivery with its own event IDs (the billing layer
// dedupes via webhook_events). Replaying a stored 200 here could also swallow a
// genuinely new event that happened to reuse a key. Excluded outright.
const EXCLUDED_PATHS = new Set(["/api/stripe/webhook"]);

let _redis: Redis | null = null;
let _adapter: StorageAdapter | null = null;
let _connected: Promise<void> | null = null;

function getAdapter(): StorageAdapter {
  if (_adapter) return _adapter;
  if (!_redis) {
    _redis = new Redis(getConfig().REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
  }
  _adapter = new RedisAdapter(_redis);
  return _adapter;
}

async function ensureConnected(): Promise<void> {
  if (!_connected) {
    _connected = getAdapter()
      .connect()
      .catch((err) => {
        _connected = null;
        throw err;
      });
  }
  await _connected;
}

function storageKeyFor(request: FastifyRequest): string | null {
  if (!MUTATING.has(request.method)) return null;
  // P2.20: skip the Stripe webhook (and any other excluded path) entirely.
  if (EXCLUDED_PATHS.has(request.url.split("?")[0]!)) return null;
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) return null;
  return generateCacheKey({
    idempotencyKey: key,
    method: request.method,
    // FULL url including the query string. The old code stripped `?...`, so the
    // same key + path with a different `?org_id=` collided and replayed the wrong
    // org's response — a cross-tenant idempotency leak. (C6)
    path: request.url,
    varyHeaders: {
      "x-idem-principal": (request.auth?.userId ?? request.auth?.apiKeyId ?? ""),
      "x-idem-org-id": request.auth?.orgId ?? "",
    },
  });
}

/** onRequest hook: replay the stored response for a repeated Idempotency-Key. */
export async function idempotencyPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sk = storageKeyFor(request);
  if (!sk) return;
  try {
    await ensureConnected();
    const record = await getAdapter().get(sk);
    if (record && typeof record.response === "string") {
      (request as unknown as { _idemReplayed?: boolean })._idemReplayed = true;
      reply.code(record.statusCode ?? 200).header("idempotency-replayed", "true");
      // Replay the STORED response headers (C6) — not a hardcoded content-type, which
      // mislabeled non-JSON responses. Skip content-length so Fastify recomputes it.
      const storedHeaders = record.headers ?? {};
      let hasContentType = false;
      for (const [k, v] of Object.entries(storedHeaders)) {
        if (k.toLowerCase() === "content-length") continue;
        if (k.toLowerCase() === "content-type") hasContentType = true;
        reply.header(k, v);
      }
      if (!hasContentType) reply.header("content-type", "application/json");
      return reply.send(record.response);
    }
  } catch {
    // Redis unavailable — proceed without idempotency.
  }
}

/** onSend hook: persist a successful response body under the Idempotency-Key. */
export async function idempotencyOnSend(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  if ((request as unknown as { _idemReplayed?: boolean })._idemReplayed) return payload;
  const sk = storageKeyFor(request);
  if (!sk) return payload;
  if (reply.statusCode < 200 || reply.statusCode >= 300) return payload;
  if (typeof payload !== "string") return payload;
  try {
    await ensureConnected();
    // Capture the actual response headers so a replay reproduces them (C6).
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(reply.getHeaders())) {
      if (typeof v === "string") headers[k] = v;
      else if (typeof v === "number") headers[k] = String(v);
      else if (Array.isArray(v)) headers[k] = v.join(", ");
    }
    const record: IdempotencyRecord = {
      response: payload,
      statusCode: reply.statusCode,
      headers,
      createdAt: Date.now(),
      ttl: TTL_MS,
    };
    await getAdapter().set(sk, record);
  } catch {
    // best-effort
  }
  return payload;
}

export async function closeIdempotencyRedis(): Promise<void> {
  if (_adapter) {
    try {
      await _adapter.disconnect();
    } catch {
      // best-effort
    }
  }
  _adapter = null;
  _connected = null;
  _redis = null;
}
