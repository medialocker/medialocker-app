import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

// The bucket-create route now provisions the backing MinIO bucket (2.3); stub the
// S3 client so the unit test exercises the route logic without a live MinIO.
vi.mock("../lib/s3.js", () => ({
  getS3: () => ({ send: async () => ({}) }),
  refreshS3Client: async () => ({ send: async () => ({}) }),
  DERIVED_BUCKET: "ml-derived",
}));

let app: FastifyInstance;

function createMockSql() {
  const userRow = { id: "test-user-id", email: "test@example.com" };
  const orgRow = { id: "test-org-id", name: "Test Org", role: "owner" };
  const countRow = { count: "0" };
  const defaultResult = Object.assign([userRow], { count: 1, command: "SELECT" as const });
  const orgListResult = Object.assign([orgRow], { count: 1, command: "SELECT" as const });
  const countResult = Object.assign([countRow], { count: 1, command: "SELECT" as const });
  const emptyResult = Object.assign([], { count: 0, command: "SELECT" as const });
  const bucketRow = { id: "bucket-1", name: "test", minio_bucket: "ml-test", versioning_enabled: false, created_at: new Date().toISOString(), object_count: "0", total_size: "0" };
  const mutationOk = Object.assign([], { count: 1, command: "INSERT" as const });
  const mutationZero = Object.assign([], { count: 0, command: "UPDATE" as const });

  function sql(strings: TemplateStringsArray, ..._values: unknown[]): Promise<any> {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();

    if (text.includes("FROM users")) return Promise.resolve(defaultResult);
    if (text.includes("organizations") && text.includes("memberships"))
      return Promise.resolve(orgListResult);
    if (text.includes("FROM api_keys WHERE bearer_lookup_hash"))
      return Promise.resolve(emptyResult);
    if (text.includes("FROM api_keys WHERE id =") || text.includes("FROM api_keys WHERE org_id"))
      return Promise.resolve(emptyResult);
    if (text.includes("FROM api_keys"))
      return Promise.resolve(emptyResult);
    if (text.includes("SELECT id FROM buckets WHERE name ="))
      return Promise.resolve(emptyResult);
    if (text.includes("WHERE b.id =") || text.includes("WHERE o.id =") || text.includes("WHERE objects.id ="))
      return Promise.resolve(emptyResult);
    if (text.includes("FROM buckets"))
      return Promise.resolve(Object.assign([bucketRow], { count: 1, command: "SELECT" as const }));
    if (text.includes("FROM objects o") && text.includes("COUNT("))
      return Promise.resolve(countResult);
    if (text.includes("FROM objects o") && text.includes("JOIN buckets"))
      return Promise.resolve(emptyResult);
    if (text.includes("FROM objects") && text.includes("LEFT JOIN"))
      return Promise.resolve(emptyResult);
    if (text.includes("FROM objects"))
      return Promise.resolve(emptyResult);
    if (text.includes("FROM tags") && text.includes("LEFT JOIN"))
      return Promise.resolve(emptyResult);
    if (text.includes("FROM tags"))
      return Promise.resolve(emptyResult);
    if (text.includes("FROM object_tags"))
      return Promise.resolve(emptyResult);
    if (text.includes("COUNT(") && text.includes("::text"))
      return Promise.resolve(countResult);
    if (text.includes("INSERT INTO")) return Promise.resolve(mutationOk);
    if (text.includes("UPDATE ")) return Promise.resolve(mutationZero);
    if (text.includes("DELETE ")) return Promise.resolve(mutationOk);
    return Promise.resolve(emptyResult);
  }

  (sql as any).unsafe = (query: string, _params?: unknown[]): Promise<any> => {
    if (typeof query === "string" && query.includes("COUNT")) {
      return Promise.resolve(countResult);
    }
    if (typeof query === "string" && query.includes("FROM objects o JOIN buckets")) {
      return Promise.resolve(emptyResult);
    }
    return Promise.resolve(emptyResult);
  };

  return sql;
}

const mockSql = createMockSql();

beforeAll(async () => {
  app = Fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    console.error("Test app error:", error);
    reply.status(500).send({ error: { code: "InternalError", message: String(error) } });
  });

  app.decorateRequest("sql", { getter: () => mockSql } as any);
  app.decorateRequest("config", {
    getter: () => ({
      API_KEY_ENC_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      SUPABASE_URL: "https://test-ref.supabase.co",
      REDIS_URL: "redis://localhost:6379",
      PUBLIC_BASE_DOMAIN: "medialocker.io",
      STRIPE_SECRET_KEY: "sk_test_dummy",
      STRIPE_WEBHOOK_SECRET: "whsec_dummy",
    }),
  } as any);

  let _auth: any = {
    userId: "test-user-id",
    orgId: "test-org-id",
    isMachine: false,
    scopes: ["read", "write", "delete", "admin"],
  };

  app.decorateRequest("auth", {
    getter: () => _auth,
    setter: (v: any) => { _auth = v; },
  } as any);

  const { authRoutes } = await import("../routes/auth.js");
  const { bucketRoutes } = await import("../routes/buckets.js");
  const { mediaRoutes } = await import("../routes/media.js");
  const { tagRoutes } = await import("../routes/tags.js");
  const { searchRoutes } = await import("../routes/search.js");

  await app.register(authRoutes, { prefix: "/api" });
  await app.register(bucketRoutes, { prefix: "/api" });
  await app.register(mediaRoutes, { prefix: "/api" });
  await app.register(tagRoutes, { prefix: "/api" });
  await app.register(searchRoutes, { prefix: "/api" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("Auth routes", () => {
  it("GET /api/me returns user info", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("user");
    expect(body).toHaveProperty("organizations");
  });

  it("POST /api/api-keys validates body (empty)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/api-keys",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("ValidationError");
  });

  it("POST /api/api-keys creates key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/api-keys",
      payload: { name: "test-key", scopes: ["read", "write"], expiresInDays: 30 },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.accessKeyId).toBeDefined();
    expect(body.secret).toBeDefined();
    // P3.8: canonical key format — access key `ml_<32 hex>`, secret 64 hex chars
    // (matches @medialocker/auth.createApiKey() + MCP issuer + packages/auth tests).
    expect(body.accessKeyId).toMatch(/^ml_[0-9a-f]{32}$/);
    expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("GET /api/api-keys returns list", async () => {
    const res = await app.inject({ method: "GET", url: "/api/api-keys" });
    expect(res.statusCode).toBe(200);
  });

  it("DELETE /api/api-keys/:id handles missing", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/api-keys/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Bucket routes", () => {
  it("POST /api/buckets validates name (too short)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/buckets",
      payload: { name: "AB" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/buckets creates bucket", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/buckets",
      payload: { name: "my-test-bucket" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.name).toBe("my-test-bucket");
    expect(body.endpoint).toBeDefined();
  });

  it("GET /api/buckets returns list", async () => {
    const res = await app.inject({ method: "GET", url: "/api/buckets" });
    expect(res.statusCode).toBe(200);
  });

  it("GET /api/buckets/:id returns 404 for non-existent", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/buckets/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Media routes", () => {
  it("GET /api/media returns paginated list", async () => {
    const res = await app.inject({ method: "GET", url: "/api/media" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("total");
  });

  it("GET /api/media/:id returns 404 for non-existent", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/media/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Tag routes", () => {
  it("POST /api/tags validates body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tags",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/tags creates tag", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tags",
      payload: { name: "Test Tag" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("GET /api/tags returns list", async () => {
    const res = await app.inject({ method: "GET", url: "/api/tags" });
    expect(res.statusCode).toBe(200);
  });
});

describe("Search routes", () => {
  it("GET /api/search requires q param", async () => {
    const res = await app.inject({ method: "GET", url: "/api/search" });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/search returns results with q", async () => {
    const res = await app.inject({ method: "GET", url: "/api/search?q=test" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("facets");
  });
});
