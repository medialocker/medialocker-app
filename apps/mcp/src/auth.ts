/**
 * Tenant authentication for the MediaLocker MCP edge (Fastify).
 *
 * Integrates the `@reaatech/mcp-gateway-*` suite, but adapts its tenant model to
 * MediaLocker's reality:
 *
 *  - The gateway's stock `fastifyAuth` (from `@reaatech/mcp-gateway-auth/fastify`)
 *    resolves tenants from a STATIC, pre-registered registry keyed on an
 *    `x-api-key` header whose SHA-256 hash matches `TenantConfig.auth.apiKeys[]`.
 *  - MediaLocker has DYNAMIC, per-org API keys stored encrypted in Postgres,
 *    presented as `Authorization: Bearer <secret>`, resolved via
 *    `bearer_lookup_hash` + a constant-time compare of the decrypted secret
 *    (so SigV4 can recompute signatures — plan §10/§23). Orgs are not known
 *    ahead of time, so there is nothing to pre-register.
 *
 * The adaptation (per plan §5's "prefer adapting our code" escape hatch): we keep
 * the gateway's *types and primitives* (`AuthContext`, `createAuthContext`,
 * `generateTokenFingerprintSync`, `TenantConfig`, `setTenant`, `MiddlewareError`)
 * and the gateway's downstream Fastify plugins (rate-limit, allowlist, audit,
 * cache) intact — they all key off `request.tenantId` / `request.authContext`
 * and `getTenant(tenantId)`. We replace ONLY the credential-resolution step with
 * a MediaLocker-aware Fastify `preHandler` hook that:
 *   1. resolves the org from the Bearer token via `@medialocker/auth`,
 *   2. builds the gateway `AuthContext` (tenantId = orgId),
 *   3. registers a dynamic `TenantConfig` for that org via `setTenant()` so the
 *      downstream allowlist/rate-limit/cache plugins "see" the tenant,
 *   4. decorates `request.tenantId = orgId` and a MediaLocker-shaped context
 *      (orgId/scopes/bucketScope) for the tool handlers.
 *
 * The `@reaatech/mcp-gateway-auth/fastify` import below brings the
 * `declare module 'fastify'` augmentation (`request.authContext?`,
 * `request.tenantId?`) into scope.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
// Imported for its `declare module 'fastify'` augmentation
// (request.authContext / request.tenantId). The plugin export is unused here.
import "@reaatech/mcp-gateway-auth/fastify";
import {
  createAuthContext,
  generateTokenFingerprintSync,
  type AuthContext as GatewayAuthContext,
} from "@reaatech/mcp-gateway-auth";
import { setTenant, type TenantConfig } from "@reaatech/mcp-gateway-core";
import { MiddlewareError, MiddlewareErrorCode } from "@reaatech/multi-tenant-mcp-types";
import {
  verifyBearerToken,
  verifySupabaseJwt,
  resolveOrgFromUser,
} from "@medialocker/auth";
import { getMembershipsForUser } from "@medialocker/db";
import { getConfig } from "@medialocker/config";
import { createLogger } from "@medialocker/observability";

const logger = createLogger("mcp:auth");

/**
 * MediaLocker-shaped auth context injected into tool handlers.
 * Matches the `ToolHandlerContext["auth"]` contract the tool files expect.
 */
export interface MediaLockerAuth {
  userId?: string;
  orgId: string;
  isMachine: boolean;
  scopes: string[];
  bucketScope: string | null;
  allowedTools: string[];
}

// Carry the MediaLocker-shaped auth on the Fastify request alongside the gateway
// AuthContext (which the augmentation in @reaatech/mcp-gateway-auth/fastify adds).
declare module "fastify" {
  interface FastifyRequest {
    mediaLockerAuth?: MediaLockerAuth;
  }
}

/** Read-only tools every authenticated tenant may call. */
export const READ_TOOLS: string[] = [
  "search_media",
  "list_buckets",
  "get_bucket_info",
  "get_object_url",
  "list_objects",
  "get_object_metadata",
  "list_sets",
  "get_usage",
  "get_billing_info",
];

/** Mutating tools — require the `write` scope (or `admin`). */
export const WRITE_TOOLS: string[] = [
  "upload_object",
  "manage_tags",
  "manage_categories",
  "create_set",
  "add_variant",
  "generate_variants",
  "create_bucket",
];

/** Destructive tools — require `delete` (or `admin`). */
export const DELETE_TOOLS: string[] = ["delete_bucket", "delete_object", "purge"];

/** Admin-only tools (billing/capacity + key issuance). */
export const ADMIN_TOOLS: string[] = ["manage_capacity", "create_api_key"];

// Retained named exports for back-compat with anything importing them.
export const DEFAULT_ALLOWLIST: string[] = [...READ_TOOLS, ...WRITE_TOOLS];
export const DESTRUCTIVE_TOOLS: string[] = DELETE_TOOLS;

/**
 * The set of tools a credential may call, derived from its scopes. The gateway
 * allowlist plugin (mode: "allow") enforces this per tenant, so a read-only key
 * can no longer reach upload/create/capacity/key-issuance tools — closing the
 * "every authenticated credential gets write/admin tools" gap.
 */
export function allowedToolsForScopes(scopes: string[]): string[] {
  const has = (s: string) => scopes.includes(s);
  const tools = [...READ_TOOLS];
  if (has("write") || has("admin")) tools.push(...WRITE_TOOLS);
  if (has("delete") || has("admin")) tools.push(...DELETE_TOOLS);
  if (has("admin")) tools.push(...ADMIN_TOOLS);
  return tools;
}

/** Map a membership role to scopes (mirrors the control-plane RBAC). */
function scopesForRole(role: string): string[] {
  switch (role) {
    case "owner":
    case "admin":
      return ["read", "write", "delete", "admin"];
    case "member":
    default:
      return ["read"];
  }
}

/**
 * Build (and register once) a dynamic gateway TenantConfig for a resolved org so the
 * downstream gateway plugins (rate-limit / cache) can resolve it
 * via `getTenant(orgId)`. Registered with the full tool set (idempotent: only the
 * first call per org takes effect). Per-credential tool allowlisting is handled
 * request-scoped via the custom `mediaLockerAllowlistHook` in the server, not via
 * this global registry.
 */
const registeredOrgs = new Set<string>();
function registerOrgTenant(orgId: string): void {
  if (registeredOrgs.has(orgId)) return;
  registeredOrgs.add(orgId);

  const allTools = [
    ...READ_TOOLS, ...WRITE_TOOLS, ...DELETE_TOOLS, ...ADMIN_TOOLS,
  ];
  const tenant: TenantConfig = {
    tenantId: orgId,
    displayName: `org:${orgId}`,
    rateLimits: {
      requestsPerMinute: 120,
      requestsPerDay: 50_000,
      burstSize: 120,
    },
    cache: {
      enabled: false,
      ttlSeconds: 30,
    },
    allowlist: {
      mode: "allow",
      tools: allTools,
    },
    upstreams: [],
  };
  setTenant(tenant);
}

/** Attach both the gateway AuthContext and the MediaLocker auth to the request. */
function attach(
  req: FastifyRequest,
  gateway: GatewayAuthContext,
  ml: MediaLockerAuth,
): void {
  registerOrgTenant(ml.orgId);
  // gateway plugins read request.tenantId (falling back to authContext.tenantId)
  req.authContext = gateway;
  req.tenantId = ml.orgId;
  // tool handlers read request.mediaLockerAuth
  req.mediaLockerAuth = ml;
}

/**
 * Resolve a customer API-key Bearer token to a MediaLocker org.
 * Reuses `@medialocker/auth.verifyBearerToken` (decrypts `secret_enc`,
 * constant-time compares, returns { orgId, scopes, bucketScope }).
 */
async function resolveApiKey(
  token: string,
): Promise<{ gateway: GatewayAuthContext; ml: MediaLockerAuth } | null> {
  const verified = await verifyBearerToken(token);
  if (!verified) return null;

  const scopes = verified.scopes ?? [];
  const gateway = createAuthContext({
    tenantId: verified.orgId,
    scopes,
    authMethod: "api-key",
    keyName: "medialocker-api-key",
    tokenFingerprint: generateTokenFingerprintSync(token),
  });
  const ml: MediaLockerAuth = {
    orgId: verified.orgId,
    isMachine: true,
    scopes,
    bucketScope: verified.bucketScope,
    allowedTools: allowedToolsForScopes(scopes),
  };
  return { gateway, ml };
}

/**
 * Resolve a Supabase user JWT to a MediaLocker org (human/session access).
 * Full scopes; org resolved from membership.
 */
async function resolveJwt(
  token: string,
): Promise<{ gateway: GatewayAuthContext; ml: MediaLockerAuth } | null> {
  let userId: string;
  let payloadOrgs: string[] = [];
  try {
    const payload = await verifySupabaseJwt(token);
    userId = payload.sub;
    if (payload.org_id) {
      payloadOrgs = Array.isArray(payload.org_id)
        ? payload.org_id.filter(Boolean)
        : [payload.org_id];
    }
  } catch {
    return null;
  }

  // P1 #M4: prefer an org_id claim/header when present — verify the user is a
  // member of that org before accepting it. Fall back to resolveOrgFromUser's
  // deterministic selection (highest role, oldest membership) when no claim.
  let orgId: string;
  let role: string;
  if (payloadOrgs.length > 0) {
    const memberships = await getMembershipsForUser(userId);
    const match = memberships.find(
      (m) => payloadOrgs.includes(m["org_id"] as string),
    );
    if (match) {
      orgId = match["org_id"] as string;
      role = match["role"] as string;
    } else {
      return null;
    }
  } else {
    const org = await resolveOrgFromUser(userId);
    if (!org) return null;
    orgId = org.orgId;
    role = org.role;
  }

  // Scopes follow the user's membership role, not a blanket admin grant.
  const scopes = scopesForRole(role);
  const gateway = createAuthContext({
    tenantId: orgId,
    userId,
    scopes,
    authMethod: "jwt",
    subject: userId,
    tokenFingerprint: generateTokenFingerprintSync(token),
  });
  const ml: MediaLockerAuth = {
    userId,
    orgId,
    isMachine: false,
    scopes,
    bucketScope: null,
    allowedTools: allowedToolsForScopes(scopes),
  };
  return { gateway, ml };
}

/**
 * Fastify `preHandler` hook: MediaLocker tenant resolution for the gateway edge.
 * Replaces `@reaatech/mcp-gateway-auth`'s static-registry plugin while producing
 * the same `request.authContext` / `request.tenantId` contract the rest of the
 * suite consumes. Registered FIRST in the gateway scope so it runs before the
 * rate-limit / allowlist / audit / cache plugins.
 */
export function mediaLockerAuthHook() {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authHeader = req.headers["authorization"];
    const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;

    if (!header || !header.startsWith("Bearer ")) {
      sendAuthError(reply, "Authentication required. Provide a Bearer token.");
      return;
    }

    const token = header.slice("Bearer ".length);

    try {
      // Prefer API-key (machine) resolution; fall back to Supabase user JWT.
      const resolved = (await resolveApiKey(token)) ?? (await resolveJwt(token));
      if (!resolved) {
        sendAuthError(reply, "Invalid API key or token.");
        return;
      }
      attach(req, resolved.gateway, resolved.ml);
    } catch (err) {
      logger.error({ err }, "auth resolution failed");
      sendAuthError(reply, "Authentication error.");
    }
  };
}

function sendAuthError(reply: FastifyReply, message: string): void {
  const error = new MiddlewareError(MiddlewareErrorCode.Unauthorized, message);
  void reply.code(401).send({
    jsonrpc: "2.0",
    error: { code: error.code, message: error.message },
  });
}

/** Read the MediaLocker auth context off a request (used by the tool bridge). */
export function getMediaLockerAuth(req: FastifyRequest): MediaLockerAuth | undefined {
  return req.mediaLockerAuth;
}

/** Re-exported so other modules don't need to import config directly. */
export { getConfig };
