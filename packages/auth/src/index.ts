import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { getConfig } from "@medialocker/config";
import {
  insertApiKey,
  getApiKeyByAccessKeyId,
  getApiKeyByBearerHash,
  revokeApiKey as dbRevokeApiKey,
  updateApiKeyLastUsed,
  getMembershipsForUser,
} from "@medialocker/db";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const config = getConfig();
  return Buffer.from(config.API_KEY_ENC_KEY, "base64");
}

export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, authTag, ciphertext]);
  return combined.toString("base64");
}

export function decrypt(encoded: string): string {
  const key = getEncryptionKey();
  const combined = Buffer.from(encoded, "base64");
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

function generateAccessKeyId(): string {
  return `ml_${crypto.randomBytes(16).toString("hex")}`;
}

function generateSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

function hashBearerToken(token: string): string {
  // MUST be hex to match the lookup hash written/read by the API middleware,
  // MCP bearer auth, and webhook provisioning. A base64 digest here makes keys
  // minted by createApiKey() unverifiable by every other consumer.
  return crypto.createHash("sha256").update(token).digest("hex");
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i]! ^ bufB[i]!;
  }
  return result === 0;
}

export interface ApiKeyResult {
  keyId: string;
  accessKeyId: string;
  secret: string;
}

export async function createApiKey(
  orgId: string,
  scopes: string[],
  bucketScope?: string,
  expiresInDays = 90,
  name?: string | null,
): Promise<ApiKeyResult> {
  const accessKeyId = generateAccessKeyId();
  const secret = generateSecret();
  const secretEnc = encrypt(secret);
  const bearerLookupHash = hashBearerToken(secret);
  const expiresAt = new Date(
    Date.now() + expiresInDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const record = await insertApiKey({
    org_id: orgId,
    access_key_id: accessKeyId,
    secret_enc: secretEnc,
    bearer_lookup_hash: bearerLookupHash,
    name: name ?? null,
    scopes,
    bucket_scope: bucketScope ?? null,
    expires_at: expiresAt,
  });

  return {
    keyId: record["id"] as string,
    accessKeyId: record["access_key_id"] as string,
    secret,
  };
}

export interface VerifiedKey {
  apiKeyId: string;
  orgId: string;
  secret: string;
  scopes: string[];
  bucketScope: string | null;
}

export async function verifySigV4Key(
  accessKeyId: string,
): Promise<VerifiedKey | null> {
  const record = await getApiKeyByAccessKeyId(accessKeyId);
  if (!record) return null;

  try {
    const secret = decrypt(record["secret_enc"] as string);
    await updateApiKeyLastUsed(record["id"] as string);
    return {
      apiKeyId: record["id"] as string,
      orgId: record["org_id"] as string,
      secret,
      scopes: record["scopes"] as string[],
      bucketScope: record["bucket_scope"] as string | null,
    };
  } catch {
    return null;
  }
}

export async function verifyBearerToken(
  token: string,
): Promise<VerifiedKey | null> {
  const hash = hashBearerToken(token);
  const record = await getApiKeyByBearerHash(hash);
  if (!record) return null;

  try {
    const decrypted = decrypt(record["secret_enc"] as string);
    if (!constantTimeCompare(token, decrypted)) {
      return null;
    }
    await updateApiKeyLastUsed(record["id"] as string);
    return {
      apiKeyId: record["id"] as string,
      orgId: record["org_id"] as string,
      secret: decrypted,
      scopes: record["scopes"] as string[],
      bucketScope: record["bucket_scope"] as string | null,
    };
  } catch {
    return null;
  }
}

export async function revokeApiKey(keyId: string): Promise<void> {
  await dbRevokeApiKey(keyId);
}

/**
 * Sign an internal service-to-service request, producing an
 * `Authorization: Internal <timestamp>:<hexsig>` header value.
 *
 * The canonical string signed is `${method.toUpperCase()}\n${path}\n${ts}`.
 * NOTE: `path` MUST exclude the query string (sign only the URL path before `?`),
 * matching the verify side in apps/api middleware.
 *
 * @param method HTTP method (case-insensitive; uppercased internally).
 * @param path Request path excluding the query string.
 * @param secret The shared INTERNAL_API_SECRET.
 * @param timestamp Optional unix-seconds timestamp; defaults to now.
 */
export function signInternalRequest(method: string, path: string, secret: string, timestamp?: number): string {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(`${method.toUpperCase()}\n${path}\n${ts}`).digest("hex");
  return `Internal ${ts}:${sig}`;
}

/**
 * Maximum clock/in-flight skew (seconds) an internal-auth timestamp may differ
 * from now. Mirrors the existing verifier window in apps/api so adopting the
 * grace-window verifier does not change replay semantics.
 */
const INTERNAL_AUTH_MAX_SKEW_SECONDS = 60;

/**
 * §5 secret-rotation loop — the VERIFIER half of `signInternalRequest`.
 *
 * Resolve the set of INTERNAL_API_SECRET values a signature may legitimately be
 * verified against during a rotation grace window: the CURRENT secret plus the
 * immediately-PREVIOUS one. Order is [current, previous].
 *
 * Source of truth precedence:
 *   1. The durable, versioned `service_secrets` store (written by the worker
 *      rotation processor) — decrypt the `current` and `previous` rows.
 *   2. Bootstrap/fallback: the env/config value (`INTERNAL_API_SECRET`). This is
 *      ALWAYS included so verification keeps working before the first rotation
 *      (the store is empty) and if the store is transiently unreadable.
 *
 * The SIGNER continues to sign with the current secret only; only the verifier is
 * lenient, which is what makes a rotation non-breaking for requests already in
 * flight or straddling the activation instant.
 *
 * `fetchVersions` is injected (rather than importing @medialocker/db here) to
 * keep this package free of a DB dependency and easy to unit-test; pass
 * `getServiceSecretVersions` from @medialocker/db at the call site.
 */
export async function resolveInternalSecretCandidates(
  fallbackSecret: string,
  fetchVersions?: (
    name: string,
  ) => Promise<{ value_enc: string; stages: string[] }[]>,
): Promise<string[]> {
  const candidates: string[] = [];
  if (fetchVersions) {
    try {
      const rows = await fetchVersions("internal-api-secret");
      // current first, then previous (the query already orders current-first).
      for (const row of rows) {
        try {
          candidates.push(decrypt(row.value_enc));
        } catch {
          // A row that fails to decrypt (e.g. key mismatch) is skipped, not fatal.
        }
      }
    } catch {
      // Store unavailable → fall back to env/config only.
    }
  }
  // Always include the bootstrap/env value as a fallback (dedup).
  if (!candidates.includes(fallbackSecret)) candidates.push(fallbackSecret);
  return candidates;
}

/**
 * Verify an `Authorization: Internal <ts>:<hexsig>` header against ANY of the
 * supplied candidate secrets (current OR previous — see
 * {@link resolveInternalSecretCandidates}), in constant time per candidate.
 *
 * This is the rotation-aware replacement for a single-secret `verifyInternalAuth`.
 * It enforces the same canonical string (`${METHOD}\n${path}\n${ts}`), the same
 * ±60s timestamp window, and a constant-time signature comparison.
 *
 * NOTE: `path` must be the URL path WITHOUT the query string, matching the signer.
 */
export function verifyInternalRequestWithSecrets(
  authHeader: string,
  method: string,
  path: string,
  candidateSecrets: string[],
): boolean {
  if (!authHeader?.startsWith("Internal ")) return false;
  const payload = authHeader.slice("Internal ".length);
  const sep = payload.indexOf(":");
  if (sep < 0) return false;
  const timestamp = payload.slice(0, sep);
  const providedSig = payload.slice(sep + 1);
  if (!timestamp || !providedSig) return false;

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > INTERNAL_AUTH_MAX_SKEW_SECONDS) return false;

  const providedBuf = Buffer.from(providedSig);
  let ok = false;
  for (const secret of candidateSecrets) {
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(`${method.toUpperCase()}\n${path}\n${timestamp}`)
      .digest("hex");
    const expectedBuf = Buffer.from(expectedSig);
    // Do NOT early-return on first match: keep scanning all candidates so the
    // total work (and timing) is independent of which secret matched.
    if (
      providedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(providedBuf as Uint8Array, expectedBuf as Uint8Array)
    ) {
      ok = true;
    }
  }
  return ok;
}

/**
 * Convenience verifier that resolves the rotation candidates (current+previous
 * from the store, env fallback) and then verifies the header. Pass
 * `getServiceSecretVersions` from @medialocker/db as `fetchVersions`, and the
 * env/config `INTERNAL_API_SECRET` as `fallbackSecret`.
 */
export async function verifyInternalRequest(
  authHeader: string,
  method: string,
  path: string,
  fallbackSecret: string,
  fetchVersions?: (
    name: string,
  ) => Promise<{ value_enc: string; stages: string[] }[]>,
): Promise<boolean> {
  const candidates = await resolveInternalSecretCandidates(
    fallbackSecret,
    fetchVersions,
  );
  return verifyInternalRequestWithSecrets(authHeader, method, path, candidates);
}


export interface SupabaseJwtPayload {
  sub: string;
  email: string;
  aud: string;
  exp: number;
  iat: number;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
  org_id?: string;
}

/**
 * JWKS cache for Supabase's asymmetric JWT signing keys. Modern Supabase projects
 * sign access tokens with ES256/RS256 keys published at
 * `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`. Keys are cached by `kid` and
 * refreshed on a miss or after a TTL.
 */
let _jwksCache: { url: string; keys: Map<string, crypto.KeyObject>; fetchedAt: number } | null =
  null;
const JWKS_TTL_MS = 10 * 60 * 1000;

async function getJwksKey(kid: string): Promise<crypto.KeyObject> {
  const config = getConfig();
  if (!config.SUPABASE_URL) throw new Error("SUPABASE_URL is not configured");
  const url = `${config.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`;

  const stale =
    !_jwksCache ||
    _jwksCache.url !== url ||
    !_jwksCache.keys.has(kid) ||
    Date.now() - _jwksCache.fetchedAt > JWKS_TTL_MS;

  if (stale) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch JWKS (${res.status})`);
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    const keys = new Map<string, crypto.KeyObject>();
    for (const jwk of body.keys ?? []) {
      const k = jwk["kid"];
      if (typeof k !== "string") continue;
      try {
        keys.set(k, crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" }));
      } catch {
        // Skip unparseable keys rather than failing the whole set.
      }
    }
    _jwksCache = { url, keys, fetchedAt: Date.now() };
  }

  const key = _jwksCache!.keys.get(kid);
  if (!key) throw new Error(`No JWKS key found for kid ${kid}`);
  return key;
}

/** Reset the JWKS cache (test seam). */
export function resetJwksCache(): void {
  _jwksCache = null;
}

/**
 * Verify a Supabase access token against the project's **asymmetric** JWT signing
 * keys (ES256/RS256), fetched from the JWKS endpoint and cached by `kid`. Modern
 * Supabase projects sign with asymmetric keys; the legacy HS256 shared secret is
 * not supported.
 *
 * Pins aud=`authenticated` and iss=`${SUPABASE_URL}/auth/v1` so a token minted for
 * another audience/issuer (or a different project) cannot be replayed here.
 */
export async function verifySupabaseJwt(token: string): Promise<SupabaseJwtPayload> {
  const config = getConfig();
  if (!config.SUPABASE_URL) throw new Error("SUPABASE_URL is not configured");

  const decoded = jwt.decode(token, { complete: true });
  const alg = decoded?.header?.alg;
  if (!alg || (!alg.startsWith("ES") && !alg.startsWith("RS"))) {
    throw new Error(
      `Unsupported JWT algorithm "${alg ?? "none"}" (expected asymmetric ES256/RS256)`,
    );
  }

  const kid = decoded?.header?.kid;
  if (!kid) throw new Error("JWT header missing kid for asymmetric verification");

  const key = await getJwksKey(kid);
  return jwt.verify(token, key, {
    algorithms: [alg as jwt.Algorithm],
    audience: "authenticated",
    issuer: `${config.SUPABASE_URL.replace(/\/$/, "")}/auth/v1`,
  }) as SupabaseJwtPayload;
}

export function decodeSupabaseJwt(token: string): SupabaseJwtPayload | null {
  try {
    const decoded = jwt.decode(token) as SupabaseJwtPayload | null;
    return decoded;
  } catch {
    return null;
  }
}

export interface ResolvedOrg {
  orgId: string;
  role: string;
}

/**
 * Role precedence for deterministic org selection (higher wins).
 * Unknown/future roles sort below all known roles.
 */
const ROLE_RANK: Record<string, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};

function roleRank(role: unknown): number {
  return ROLE_RANK[String(role)] ?? 0;
}

/**
 * Resolve the single org a user acts under from their memberships.
 *
 * P2 fix: previously this returned `memberships[0]`, whose order is whatever the
 * DB happened to return (no ORDER BY) — nondeterministic, so a multi-org user
 * could be silently scoped to the wrong org between requests. Selection is now
 * fully deterministic:
 *   1. highest role wins (owner > admin > member > unknown),
 *   2. tie-broken by OLDEST membership (created_at ascending) — the user's
 *      "home"/original org,
 *   3. final stable tie-break by org_id (lexicographic) so the result is
 *      identical even if created_at is absent/equal.
 * `created_at` may be a Date, an ISO string, or missing; all compare safely.
 */
export async function resolveOrgFromUser(
  userId: string,
): Promise<ResolvedOrg | null> {
  const memberships = await getMembershipsForUser(userId);
  if (memberships.length === 0) return null;

  const createdAtMs = (m: Record<string, unknown>): number => {
    const raw = m["created_at"];
    if (!raw) return Number.POSITIVE_INFINITY; // unknown age sorts last (newest)
    const t = new Date(raw as string | number | Date).getTime();
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };

  const sorted = [...memberships].sort((a, b) => {
    const rankDelta = roleRank(b["role"]) - roleRank(a["role"]);
    if (rankDelta !== 0) return rankDelta; // higher role first
    const ageDelta = createdAtMs(a) - createdAtMs(b);
    if (ageDelta !== 0) return ageDelta; // oldest first
    return String(a["org_id"]).localeCompare(String(b["org_id"])); // stable
  });

  const active = sorted[0]!;
  return {
    orgId: active["org_id"] as string,
    role: active["role"] as string,
  };
}
