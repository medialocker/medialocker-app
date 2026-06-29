import { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { encrypt } from "@medialocker/auth";
import { validate } from "../middleware/validation.js";
import { requireScope } from "../middleware/auth.js";

const createApiKeySchema = z.object({
  name: z.string().min(1).max(128),
  // P2.22: an explicitly-supplied empty array is invalid — a scopeless key can
  // authenticate but do nothing, which is almost always a client bug. Require at
  // least one scope; default to read-only when the field is omitted entirely.
  scopes: z.array(z.enum(["read", "write", "delete", "admin"])).min(1).default(["read"]),
  bucketId: z.string().uuid().optional(),
  expiresInDays: z.number().int().min(1).max(365).default(90),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/me",
    { preHandler: [validate({}), requireScope("read")] },
    async (request, reply) => {
      const { sql, auth } = request;

      // P2.21: machine principals (API key / bearer) have no users row and no
      // membership — they authenticate as an API key bound directly to an org.
      // The old code looked up `users WHERE id = ''` and 404'd, so /api/me was
      // unusable for machine callers. Return principal info derived from the API
      // key + its org instead, mirroring the human-user shape where possible.
      if (auth.isMachine) {
        const keyRows = await sql<{ id: string; name: string | null; scopes: string[]; bucket_scope: string | null }[]>`
          SELECT id, name, scopes, bucket_scope
          FROM api_keys
          WHERE id = ${auth.apiKeyId ?? ""} AND org_id = ${auth.orgId}
          LIMIT 1
        `;
        const orgRows = await sql<{ id: string; name: string }[]>`
          SELECT id, name FROM organizations WHERE id = ${auth.orgId} LIMIT 1
        `;
        const org = orgRows[0] ?? null;
        const key = keyRows[0];
        return {
          principal: {
            type: "api_key",
            apiKeyId: auth.apiKeyId ?? null,
            name: key?.name ?? null,
            scopes: key?.scopes ?? auth.scopes,
            bucketScope: key?.bucket_scope ?? auth.bucketScope ?? null,
          },
          user: null,
          organizations: org ? [{ id: org.id, name: org.name, role: "machine" }] : [],
          currentOrg: org ? { id: org.id, name: org.name, role: "machine" } : null,
        };
      }

      const users = await sql<{ id: string; email: string }[]>`
        SELECT id, email FROM users WHERE id = ${auth.userId ?? ""}
      `;
      if (users.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "User not found" } });
      }
      const orgs = await sql<{ id: string; name: string; role: string }[]>`
        SELECT o.id, o.name, m.role
        FROM organizations o
        JOIN memberships m ON m.org_id = o.id
        WHERE m.user_id = ${auth.userId ?? ""}
      `;
      return {
        principal: { type: "user", userId: users[0]!.id },
        user: users[0],
        organizations: orgs,
        currentOrg: orgs.find((o: { id: string }) => o.id === auth.orgId) ?? orgs[0] ?? null,
      };
    },
  );

  app.post(
    "/api-keys",
    { preHandler: [validate({ body: createApiKeySchema }), requireScope("admin")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const body = request.body as z.infer<typeof createApiKeySchema>;

      // P3.8: canonical key format — `ml_<32 hex>` access key + 64-hex secret,
      // matching @medialocker/auth.createApiKey(), the MCP issuer, and the
      // apiKeys test assertions (/^ml_[0-9a-f]{32}$/, /^[0-9a-f]{64}$/).
      const accessKeyId = `ml_${crypto.randomBytes(16).toString("hex")}`;
      const secret = crypto.randomBytes(32).toString("hex");
      const bearerLookupHash = crypto.createHash("sha256").update(secret).digest("hex");
      const expiresAt = new Date(Date.now() + body.expiresInDays * 86400000).toISOString();

      // bucket_scope is compared against the bucket NAME by the gateway SigV4
      // verifier and the MCP key selector — NOT the UUID. So resolve the supplied
      // bucketId to its name and store that, or the scoped key would never match
      // any bucket. (Closes the UUID-vs-name bucket_scope inconsistency.)
      let bucketScope: string | null = null;
      if (body.bucketId) {
        const b = await sql<{ name: string }[]>`
          SELECT name FROM buckets
          WHERE id = ${body.bucketId} AND org_id = ${auth.orgId} AND deleted_at IS NULL
          LIMIT 1
        `;
        if (b.length === 0) {
          return reply.status(404).send({ error: { code: "NotFound", message: "Bucket not found" } });
        }
        bucketScope = b[0]!.name;
      }

      // Use the canonical AES-256-GCM layout from @medialocker/auth so the secret
      // round-trips with decrypt() (used by SigV4 verify + presign signing).
      const secretEnc = encrypt(secret);

      const keyId = crypto.randomUUID();

      await sql`
        INSERT INTO api_keys (id, org_id, name, access_key_id, secret_enc, bearer_lookup_hash, scopes, bucket_scope, expires_at)
        VALUES (${keyId}, ${auth.orgId}, ${body.name}, ${accessKeyId}, ${secretEnc}, ${bearerLookupHash}, ${body.scopes}, ${bucketScope}, ${expiresAt})
      `;

      await sql`
        INSERT INTO audit_log (org_id, actor, action, target, ip)
        VALUES (${auth.orgId}, ${auth.userId ?? auth.apiKeyId ?? "system"}, 'api_key.create', ${keyId}, ${request.ip})
      `;

      reply.status(201).send({
        id: keyId,
        name: body.name,
        accessKeyId,
        secret,
        scopes: body.scopes,
        expiresAt,
        note: "Store this secret securely — it will not be shown again.",
      });
    },
  );

  app.get(
    "/api-keys",
    { preHandler: [validate({}), requireScope("admin")] },
    async (request, _reply) => {
      const { sql, auth } = request;
      const keys = await sql<{
        id: string;
        name: string | null;
        access_key_id: string;
        scopes: string[];
        bucket_scope: string | null;
        expires_at: string | null;
        last_used_at: string | null;
        revoked_at: string | null;
        created_at: string;
      }[]>`
        SELECT id, name, access_key_id, scopes, bucket_scope, expires_at, last_used_at, revoked_at, created_at
        FROM api_keys
        WHERE org_id = ${auth.orgId}
          AND revoked_at IS NULL
        ORDER BY created_at DESC
      `;
      return { keys };
    },
  );

  app.delete(
    "/api-keys/:id",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }) }), requireScope("admin")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id } = request.params as { id: string };
      const result = await sql`
        UPDATE api_keys SET revoked_at = now()
        WHERE id = ${id} AND org_id = ${auth.orgId} AND revoked_at IS NULL
      `;
      if (result.count === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "API key not found or already revoked" } });
      }
      await sql`
        INSERT INTO audit_log (org_id, actor, action, target, ip)
        VALUES (${auth.orgId}, ${auth.userId ?? auth.apiKeyId ?? "system"}, 'api_key.revoke', ${id}, ${request.ip})
      `;
      return { status: "revoked" };
    },
  );

  app.put(
    "/api-keys/:id/rotate",
    { preHandler: [validate({ params: z.object({ id: z.string().uuid() }) }), requireScope("admin")] },
    async (request, reply) => {
      const { sql, auth } = request;
      const { id } = request.params as { id: string };

      const keys = await sql<{ id: string; name: string | null; access_key_id: string }[]>`
        SELECT id, name, access_key_id FROM api_keys
        WHERE id = ${id} AND org_id = ${auth.orgId} AND revoked_at IS NULL
      `;
      if (keys.length === 0) {
        return reply.status(404).send({ error: { code: "NotFound", message: "API key not found" } });
      }

      const newSecret = crypto.randomBytes(32).toString("base64url");
      const newHash = crypto.createHash("sha256").update(newSecret).digest("hex");
      const newSecretEnc = encrypt(newSecret);

      await sql`
        UPDATE api_keys SET secret_enc = ${newSecretEnc}, bearer_lookup_hash = ${newHash}
        WHERE id = ${id} AND org_id = ${auth.orgId}
      `;

      await sql`
        INSERT INTO audit_log (org_id, actor, action, target, ip)
        VALUES (${auth.orgId}, ${auth.userId ?? auth.apiKeyId ?? "system"}, 'api_key.rotate', ${id}, ${request.ip})
      `;

      return {
        id: keys[0]!.id,
        name: keys[0]!.name ?? keys[0]!.access_key_id,
        accessKeyId: keys[0]!.access_key_id,
        secret: newSecret,
        note: "Previous secret is no longer valid. Store this new secret securely.",
      };
    },
  );
}
