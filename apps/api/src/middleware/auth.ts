import { FastifyRequest, FastifyReply } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getConfig, type EnvConfig } from "@medialocker/config";
import { createLogger } from "@medialocker/observability";
import { verifyInternalRequest, verifyBearerToken, verifySupabaseJwt } from "@medialocker/auth";
import { getServiceSecretVersions } from "@medialocker/db";
import postgres from "postgres";

const logger = createLogger("api:auth");

export interface AuthContext {
  userId?: string;
  orgId: string;
  isMachine: boolean;
  scopes: string[];
  apiKeyId?: string;
  bucketScope?: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
    sql: ReturnType<typeof postgres>;
    // Use the canonical config type so it stays in sync with @medialocker/config
    // (the previous hand-maintained literal had drifted, e.g. SUPABASE_* were
    // typed required while the schema marks them optional).
    config: EnvConfig;
  }
}

/**
 * Map a membership role to the coarse scope set used for authorization.
 * owner/admin get full control; members are read-only. Without this, every
 * authenticated user was granted admin regardless of their role.
 */
export function scopesForRole(role: string): string[] {
  switch (role) {
    case "owner":
    case "admin":
      return ["read", "write", "delete", "admin"];
    case "member":
    default:
      return ["read"];
  }
}

export function verifyInternalAuth(authHeader: string, method: string, path: string): boolean {
  if (!authHeader?.startsWith("Internal ")) return false;
  const payload = authHeader.slice("Internal ".length);
  const sep = payload.indexOf(":");
  if (sep < 0) return false;
  const timestamp = payload.slice(0, sep);
  const providedSig = payload.slice(sep + 1);
  if (!timestamp || !providedSig) return false;

  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > 60) return false;

  const expectedSig = createHmac("sha256", getConfig().INTERNAL_API_SECRET)
    .update(`${method}\n${path}\n${timestamp}`)
    .digest("hex");

  const providedBuf = Buffer.from(providedSig);
  const expectedBuf = Buffer.from(expectedSig);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf as Uint8Array, expectedBuf as Uint8Array);
}

async function verifyApiKey(token: string): Promise<AuthContext | null> {
  // C5: delegate to the canonical bearer-token verifier from @medialocker/auth
  // instead of re-implementing AES-GCM decrypt + compare inline. The old code
  // duplicated the crypto and used a non-constant-time comparison.
  const verified = await verifyBearerToken(token);
  if (!verified) return null;
  return {
    orgId: verified.orgId,
    isMachine: true,
    scopes: verified.scopes,
    apiKeyId: verified.apiKeyId,
    bucketScope: verified.bucketScope,
  };
}

async function verifySupabaseToken(token: string): Promise<{ userId: string } | null> {
  try {
    const payload = await verifySupabaseJwt(token);
    return { userId: payload.sub };
  } catch {
    return null;
  }
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sql = request.sql;
  const authHeader = request.headers.authorization;

  if (authHeader?.startsWith("Internal ")) {
    // Rotation-aware: accept a signature valid under the CURRENT or the
    // immediately-PREVIOUS INTERNAL_API_SECRET (grace window from service_secrets),
    // falling back to the env value before the first rotation. The signer still
    // uses the current secret only.
    const internalOk = await verifyInternalRequest(
      authHeader,
      request.method,
      request.url.split("?")[0]!,
      getConfig().INTERNAL_API_SECRET,
      getServiceSecretVersions,
    );
    if (!internalOk) {
      void reply.status(401).send({ error: { code: "Unauthorized", message: "Invalid internal auth" } });
      return;
    }
    const orgId = (request.query as Record<string, unknown>).org_id as string | undefined;
    if (!orgId) {
      void reply.status(400).send({ error: { code: "BadRequest", message: "org_id required for internal auth" } });
      return;
    }
    request.auth = { orgId, isMachine: false, scopes: ["read", "write", "delete", "admin"] };
    return;
  }

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length);

    const supabaseUser = await verifySupabaseToken(token);
    if (supabaseUser) {
      const requestedOrgId = (request.query as Record<string, unknown>).org_id as string | undefined;

      // Resolve the org and the caller's role from their membership. When an
      // explicit org_id is supplied we MUST verify the user actually belongs to
      // it — otherwise any authenticated user could act on any organization by
      // passing ?org_id=. When omitted, fall back to their first membership.
      let membership: { org_id: string; role: string } | undefined;
      if (requestedOrgId) {
        const rows = await sql<{ org_id: string; role: string }[]>`
          SELECT org_id, role FROM memberships
          WHERE user_id = ${supabaseUser.userId} AND org_id = ${requestedOrgId}
          LIMIT 1
        `;
        membership = rows[0];
        if (!membership) {
          void reply.status(403).send({ error: { code: "Forbidden", message: "Not a member of this organization" } });
          return;
        }
      } else {
        // Deterministic default-org selection for multi-membership users: highest
        // role first (owner > admin > member), then oldest membership, then org_id
        // as a stable tiebreak. A bare `LIMIT 1` with no ORDER BY let Postgres pick
        // a different org per request (C3) — mirrors @medialocker/auth.resolveOrgFromUser.
        const rows = await sql<{ org_id: string; role: string }[]>`
          SELECT org_id, role FROM memberships
          WHERE user_id = ${supabaseUser.userId}
          ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
                   created_at ASC, org_id ASC
          LIMIT 1
        `;
        membership = rows[0];
        if (!membership) {
          void reply.status(403).send({ error: { code: "Forbidden", message: "No organization membership" } });
          return;
        }
      }

      request.auth = {
        userId: supabaseUser.userId,
        orgId: membership.org_id,
        isMachine: false,
        scopes: scopesForRole(membership.role),
      };
      return;
    }

    const apiKeyAuth = await verifyApiKey(token);
    if (apiKeyAuth) {
      request.auth = apiKeyAuth;
      return;
    }
  }

  void reply.status(401).send({ error: { code: "Unauthorized", message: "Invalid or missing authentication" } });
}

export function requireScope(scope: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.auth.scopes.includes(scope) && !request.auth.scopes.includes("admin")) {
      return reply.status(403).send({
        error: { code: "Forbidden", message: `Missing required scope: ${scope}` },
      });
    }
  };
}

/**
 * Enforce auth.bucketScope: when an API key is restricted to a single bucket,
 * reject or scope-list every data-plane operation to that bucket. Callers that
 * resolve a bucket name (e.g. from query/body) must pass it; routes where the
 * bucket is implicit in an object-ID lookup must validate via the DB.
 *
 * Without this, a bucket-scoped API key can list/search/delete objects and
 * manage buckets/tags/sets/billing across the entire org.
 */
export function requireBucketScope(bucketNameParam?: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = request.auth.bucketScope;
    if (!scope) return; // No bucket scope restriction — allow.

    // If the caller supplies the resolved bucket name we already have, check it.
    if (bucketNameParam) {
      const resolved = (request as any)[bucketNameParam] as string | undefined;
      if (resolved && resolved !== scope) {
        return reply.status(403).send({
          error: { code: "Forbidden", message: "API key is scoped to a different bucket" },
        });
      }
    }
    // Additional DB-level checks for object-ID-based routes happen inline in
    // the route handlers (they already JOIN through buckets and check org_id).
  };
}
