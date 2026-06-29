/**
 * MediaLocker MCP server (`mcp.medialocker.io`, `/mcp`).
 *
 * Built on the MCP gateway and server packages (plan §12 / §5), Fastify edition:
 *
 *   Runtime      @reaatech/mcp-server-core (SERVER_INFO, content helpers),
 *                @reaatech/mcp-server-transport (Streamable HTTP + sessions),
 *                @reaatech/mcp-server-tools (tool registry),
 *                @reaatech/mcp-server-observability (logs / metrics / traces).
 *   Multi-tenant @reaatech/mcp-gateway-auth (tenant resolution — adapted to
 *                MediaLocker's Bearer/DB model, see ./auth), -rate-limit
 *                (per-tenant token bucket, Redis), -allowlist (per-tenant tool
 *                access), -audit (audit_log sink, see ./gateway-audit), -cache
 *                (response cache), with shared contracts from
 *                @reaatech/multi-tenant-mcp-types.
 *   Firewall     @reaatech/tool-use-firewall-* gates destructive tools (./firewall).
 *
 * As of @reaatech/mcp-server-transport@1.2.0 + @reaatech/mcp-gateway-*@1.1.0 the
 * transport and the gateway suite ship Fastify adapters (`<pkg>/fastify`), so the
 * server is hosted on Fastify instead of Express.
 *
 * Pipeline (registration order == hook order within the gateway scope):
 *   auth hook → request-scope → rate-limit → allowlist (req-scoped) → audit → cache → transport
 *
 * The gateway plugins are wrapped with `fastify-plugin`, so registering them
 * inside a single `app.register(async (scope) => { ... })` attaches their
 * `preHandler` hooks to that scope. The transport plugin is NOT fastify-plugin-
 * wrapped, so it encapsulates its `/mcp` routes in a child of that scope — and a
 * child inherits the parent scope's hooks. Registering the transport last inside
 * the same scope therefore runs auth → ... → cache before every transport route.
 * The public discovery + health routes are registered on the ROOT instance,
 * outside this scope, so they receive none of those hooks.
 */
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import fastifyStreamableHTTP from "@reaatech/mcp-server-transport/fastify";
import fastifyRateLimit from "@reaatech/mcp-gateway-rate-limit/fastify";
import fastifyAudit from "@reaatech/mcp-gateway-audit/fastify";
import fastifyCache from "@reaatech/mcp-gateway-cache/fastify";
import {
  initObservability,
  shutdownObservability,
  setActiveSessionCount,
} from "@reaatech/mcp-server-observability";
import { createRateLimiter } from "@reaatech/mcp-gateway-rate-limit";
import { CacheManager } from "@reaatech/mcp-gateway-cache";
import { createClient } from "redis";
import postgres from "postgres";
import { getConfig } from "@medialocker/config";
import { createLogger } from "@medialocker/observability";
import { mediaLockerAuthHook, getMediaLockerAuth } from "./auth.js";
import { DESTRUCTIVE_TOOL_NAMES } from "./firewall.js";
import { initGatewayAudit, getGatewayAuditLogger } from "./gateway-audit.js";
import { createMediaLockerMcpServer, registerMediaLockerTools } from "./server.js";
import { llmsTxtRoutes } from "./llms-txt.js";
import { closeQueues } from "./queues.js";
import { MCP_VERSION } from "./version.js";

const logger = createLogger("mcp");
const cfg = getConfig();

const sql = postgres(cfg.DATABASE_URL, {
  // Supabase Cloud transaction pooler (6543): no prepared statements; TLS via
  // the connection string. Smaller pool than the API (lower MCP concurrency).
  max: 5,
  idle_timeout: 30,
  connect_timeout: 10,
  prepare: false,
});

let rateLimiterRedisClient: ReturnType<typeof createClient> | null = null;

/**
 * Fastify `preHandler` that populates the request-scoped context on the raw
 * Node.js IncomingMessage so the transport can thread it through authInfo to the
 * MCP SDK handlers, where `requestScope.run()` establishes the AsyncLocalStorage
 * store for the tool dispatch.
 */
function requestScopePreHandler() {
  return async (
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
  ): Promise<void> => {
    const auth = getMediaLockerAuth(req);
    if (!auth) {
      await reply.code(401).send({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Authentication required." },
      });
      return;
    }
    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId =
      (Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader) ??
      `sess_${auth.orgId}`;
    const requestId = `req_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    (req.raw as any).auth = { sql, config: cfg, auth, requestId, sessionId };
  };
}

/**
 * Fastify `preHandler` that enforces per-credential tool allowlisting request-scoped
 * instead of via the global `setTenant()` registry. Reads the tool name from the
 * JSON-RPC body and checks against `mediaLockerAuth.allowedTools`.
 */
function mediaLockerAllowlistHook() {
  return async (
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
  ): Promise<void> => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || body.method !== "tools/call") return;

    const params = body.params as Record<string, unknown> | undefined;
    const toolName = params?.name as string | undefined;
    if (!toolName) return;

    const auth = getMediaLockerAuth(req);
    if (!auth) {
      await reply.code(401).send({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Authentication required." },
      });
      return;
    }

    if (!auth.allowedTools.includes(toolName)) {
      logger.warn({ tool: toolName, orgId: auth.orgId, scopes: auth.scopes }, "tool blocked by allowlist");
      await reply.code(403).send({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: `Access denied: tool '${toolName}' is not permitted for this credential.`,
        },
      });
    }
  };
}

async function buildApp() {
  await initObservability();
  initGatewayAudit(sql);
  registerMediaLockerTools();

  // Per-tenant rate limiter (token bucket). Redis-backed in prod (plan §12).
  let rateLimiter;
  try {
    const redisClient = createClient({ url: cfg.REDIS_URL });
    redisClient.on("error", (err) => logger.error({ err }, "rate-limit redis error"));
    await redisClient.connect();
    rateLimiterRedisClient = redisClient;
    rateLimiter = createRateLimiter({
      storeType: "redis",
      redisClient: redisClient as unknown as Parameters<
        typeof createRateLimiter
      >[0]["redisClient"],
      defaultConfig: { requestsPerMinute: 120, requestsPerDay: 50_000, burstSize: 120 },
    });
  } catch (err) {
    if (process.env.MCP_ALLOW_MEMORY_RATE_LIMITER !== 'true') {
      logger.error({ err }, "Redis required for rate limiting; refusing to start (set MCP_ALLOW_MEMORY_RATE_LIMITER=true to force in-memory fallback)");
      process.exit(1);
    }
    logger.warn({ err }, "rate-limit redis unavailable; falling back to in-memory store");
    rateLimiter = createRateLimiter({
      storeType: "memory",
      defaultConfig: { requestsPerMinute: 120, requestsPerDay: 50_000, burstSize: 120 },
    });
  }

  // Response cache DISABLED (§5.5). A single in-memory CacheManager shared across
  // tenants risks serving one org's tool results to another, and caching the
  // POST /mcp JSON-RPC endpoint (which carries both reads and MUTATIONS) would
  // serve stale results after a write. Until the cache is Redis-backed with
  // tenant- + method-aware keys (and skips mutating tools), it stays off.
  const cache = new CacheManager({ enabled: false, defaultTtlSeconds: 30 });

  // INTERNAL TLS (§8.4): in-cluster traffic to Redis flows over the Docker bridge
  // unencrypted (confined to the host). Postgres + Auth (Supabase Cloud) and object
  // storage (Hetzner) are external, reached over the public network WITH TLS.
  // Add mTLS or a service mesh if the internal network spans multiple hosts.
  const app = Fastify({ bodyLimit: 4 * 1024 * 1024, logger: false });

  // Discovery + health are PUBLIC (no auth): registered on the root instance,
  // outside the authenticated gateway scope, so none of the gateway hooks apply.
  llmsTxtRoutes(app);
  app.get("/mcp/health", async () => ({ status: "ok", version: MCP_VERSION }));

  // Authenticated gateway scope. All hooks below are added to THIS scope (in
  // registration order) and cascade to the transport's encapsulated /mcp routes:
  //   auth → request-scope → rate-limit → allowlist (req-scoped) → audit → cache → transport.
  await app.register(async (scope) => {
    // 1. Custom MediaLocker auth (Bearer→org). MUST run first.
    scope.addHook("preHandler", mediaLockerAuthHook());
    // 2. Carry { sql, auth, config } into the tool handlers via AsyncLocalStorage.
    scope.addHook("preHandler", requestScopePreHandler());
    // 3. Per-tenant token bucket.
    await scope.register(fastifyRateLimit, { limiter: rateLimiter });
    // 4. Per-credential tool allowlist (request-scoped, no global registry race).
    scope.addHook("preHandler", mediaLockerAllowlistHook());
    // 5. Audit sink (audit_log via our composite logger; silent if unavailable).
    const auditLogger = getGatewayAuditLogger();
    await scope.register(
      fastifyAudit,
      auditLogger ? { logger: auditLogger } : {},
    );
    // 6. Per-tenant response cache (memory CacheManager).
    await scope.register(fastifyCache, { manager: cache });
    // 7. Streamable HTTP transport (POST /mcp, DELETE /mcp) with sessions.
    await scope.register(fastifyStreamableHTTP, {
      serverFactory: () => createMediaLockerMcpServer(),
      path: "/mcp",
    });
  });

  setActiveSessionCount(0);
  return app;
}

async function main() {
  const app = await buildApp();
  const port = cfg.NODE_ENV === "test" ? 0 : 3003;
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "MCP server started");

  const shutdown = async () => {
    await shutdownObservability().catch(() => undefined);
    await app.close().catch(() => undefined);
    await closeQueues().catch(() => undefined);
    if (rateLimiterRedisClient) {
      await rateLimiterRedisClient.disconnect().catch(() => undefined);
    }
    await sql.end({ timeout: 5 }).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Only auto-start outside the test runner (NODE_ENV is sourced via @medialocker/config).
if (cfg.NODE_ENV !== "test") {
  main().catch((err) => {
    logger.error({ err }, "Failed to start MCP server");
    process.exit(1);
  });
}

export { buildApp, sql };
