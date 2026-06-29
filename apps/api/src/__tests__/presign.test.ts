import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

// §9 RELEASE GATE: the API is the sole authorization point now that the SigV4
// gateway is gone. Every presign route must confirm the caller's org owns the
// target bucket BEFORE signing with the master credential. These tests lock that
// in (cross-tenant denial) plus the optimistic quota gate (§8.1/§8.2) and the
// idempotent confirm true-up (§8.3).

// Stub the presign signing lib so we never touch a real S3 client / network.
vi.mock("../lib/presign.js", () => ({
  presignGet: async () => "https://hetzner.example/signed-get",
  presignPut: async () => "https://hetzner.example/signed-put",
  presignCreateMultipart: async () => "https://hetzner.example/signed-create",
  presignUploadPart: async () => "https://hetzner.example/signed-part",
  presignCompleteMultipart: async () => "https://hetzner.example/signed-complete",
  buildTaggingValue: (tags?: string[]) => (tags && tags.length ? tags.join("&") : undefined),
}));

// Stub the master-cred S3 client used by the confirm HEAD.
const headState = { throws: false, size: 1024 };
vi.mock("../lib/s3.js", () => ({
  getS3: () => ({
    send: async (cmd: any) => {
      if (cmd?.constructor?.name === "HeadObjectCommand") {
        if (headState.throws) throw new Error("NoSuchKey");
        return { ContentLength: headState.size, ETag: '"abc123"', ContentType: "image/png" };
      }
      return {};
    },
  }),
  refreshS3Client: async () => ({}),
  DERIVED_BUCKET: "ml-derived",
}));

const probeAdd = vi.fn(async () => ({}));
vi.mock("../lib/queues.js", () => ({
  getProbeQueue: () => ({ add: probeAdd }),
}));

const autoAdd = vi.fn(async () => ({ added: false }));
vi.mock("@medialocker/billing", () => ({
  autoAddCapacity: (...args: unknown[]) => autoAdd(...(args as [])),
}));

vi.mock("@medialocker/core", () => ({
  reconcileCapacity: vi.fn(async () => {}),
  acquireOrgLock: vi.fn(async () => {}),
}));

// Mutable scenario the mock SQL reads. Reset in beforeEach.
const state = {
  owned: true,
  capacity: { used: "0", allocated: "1000000000" },
  existingObject: null as { id: string; size: string } | null,
};

const OWNED_BUCKET = { id: "bucket-1", name: "test", minio_bucket: "ml-test" };

function makeSql() {
  const route = (text: string): unknown[] => {
    const t = text.replace(/\s+/g, " ").trim();
    // resolveOwnedBucket — THE ownership gate.
    if (t.includes("FROM buckets") && t.includes("minio_bucket") && t.includes("org_id")) {
      return state.owned ? [OWNED_BUCKET] : [];
    }
    // download object lookup (org-scoped JOIN).
    if (t.includes("FROM objects o") && t.includes("JOIN buckets")) {
      return state.owned ? [{ id: "obj-1", key: "k", storage_bucket: "ml-test" }] : [];
    }
    if (t.includes("FROM capacity")) {
      return [{ used_bytes: state.capacity.used, allocated_bytes: state.capacity.allocated }];
    }
    if (t.includes("SELECT id, size FROM objects")) {
      return state.existingObject ? [state.existingObject] : [];
    }
    if (t.includes("INSERT INTO objects")) return [{ id: "obj-new" }];
    return [];
  };

  function sql(strings: TemplateStringsArray, ..._v: unknown[]): Promise<any> {
    return Promise.resolve(route(strings.join(" ")));
  }
  (sql as any).begin = async (cb: (tx: any) => Promise<any>) => {
    const tx = (strings: TemplateStringsArray, ..._v: unknown[]) =>
      Promise.resolve(route(strings.join(" ")));
    return cb(tx);
  };
  return sql;
}

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    reply.status(500).send({ error: { code: "InternalError", message: String(error) } });
  });

  const mockSql = makeSql();
  app.decorateRequest("sql", { getter: () => mockSql } as any);
  app.decorateRequest("config", { getter: () => ({ PUBLIC_BASE_DOMAIN: "medialocker.io" }) } as any);
  app.decorateRequest("auth", {
    getter: () => ({ userId: "u1", orgId: "org-A", isMachine: false, scopes: ["read", "write", "delete", "admin"] }),
  } as any);

  const { presignRoutes } = await import("../routes/presign.js");
  await app.register(presignRoutes, { prefix: "/api" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  state.owned = true;
  state.capacity = { used: "0", allocated: "1000000000" };
  state.existingObject = null;
  headState.throws = false;
  headState.size = 1024;
  probeAdd.mockClear();
  autoAdd.mockClear();
  autoAdd.mockResolvedValue({ added: false } as any);
});

const post = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url, payload });

describe("§9 release gate — cross-tenant denial (caller does NOT own the bucket)", () => {
  const BID = "00000000-0000-0000-0000-000000000001";
  beforeEach(() => { state.owned = false; });

  it("POST /presign/upload → 404 when bucket not owned", async () => {
    const res = await post("/api/presign/upload", { bucketId: BID, key: "k", size: 10 });
    expect(res.statusCode).toBe(404);
  });
  it("POST /presign/create-multipart → 404 when bucket not owned", async () => {
    const res = await post("/api/presign/create-multipart", { bucketId: BID, key: "k" });
    expect(res.statusCode).toBe(404);
  });
  it("POST /presign/upload-part → 404 when bucket not owned", async () => {
    const res = await post("/api/presign/upload-part", { bucketId: BID, key: "k", uploadId: "u", partNumber: 1 });
    expect(res.statusCode).toBe(404);
  });
  it("POST /presign/complete-upload → 404 when bucket not owned", async () => {
    const res = await post("/api/presign/complete-upload", { bucketId: BID, key: "k", uploadId: "u" });
    expect(res.statusCode).toBe(404);
  });
  it("POST /presign/confirm → 404 when bucket not owned (no HEAD, no objects write)", async () => {
    const res = await post("/api/presign/confirm", { bucketId: BID, key: "k" });
    expect(res.statusCode).toBe(404);
    expect(probeAdd).not.toHaveBeenCalled();
  });
  it("POST /presign/download → 404 when object not in caller's org", async () => {
    const res = await post("/api/presign/download", { objectId: BID });
    expect(res.statusCode).toBe(404);
  });
});

describe("§8.1 optimistic quota gate on /presign/upload", () => {
  const BID = "00000000-0000-0000-0000-000000000001";
  it("under quota → 200 with a presigned PUT url", async () => {
    const res = await post("/api/presign/upload", { bucketId: BID, key: "k", size: 10 });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).url).toContain("signed-put");
  });
  it("over quota + auto-capacity fails → 409 InsufficientStorage", async () => {
    state.capacity = { used: "1000000000", allocated: "1000000000" };
    autoAdd.mockResolvedValue({ added: false } as any);
    const res = await post("/api/presign/upload", { bucketId: BID, key: "k", size: 5000 });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("InsufficientStorage");
  });
  it("over quota but auto-capacity succeeds → 200", async () => {
    state.capacity = { used: "1000000000", allocated: "1000000000" };
    autoAdd.mockResolvedValue({ added: true } as any);
    const res = await post("/api/presign/upload", { bucketId: BID, key: "k", size: 5000 });
    expect(res.statusCode).toBe(200);
  });
});

describe("§8.2 optimistic reserve on /presign/create-multipart (client-declared size)", () => {
  const BID = "00000000-0000-0000-0000-000000000001";
  it("over quota with declared size + auto-capacity fails → 409", async () => {
    state.capacity = { used: "1000000000", allocated: "1000000000" };
    autoAdd.mockResolvedValue({ added: false } as any);
    const res = await post("/api/presign/create-multipart", { bucketId: BID, key: "k", size: 5000 });
    expect(res.statusCode).toBe(409);
  });
  it("no declared size → skips the gate, 200", async () => {
    state.capacity = { used: "1000000000", allocated: "1000000000" };
    const res = await post("/api/presign/create-multipart", { bucketId: BID, key: "k" });
    expect(res.statusCode).toBe(200);
  });
});

describe("§8.3 confirm true-up", () => {
  const BID = "00000000-0000-0000-0000-000000000001";
  it("first confirm → 200, writes objects row, enqueues probe", async () => {
    const res = await post("/api/presign/confirm", { bucketId: BID, key: "k" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("confirmed");
    expect(body.size).toBe("1024");
    expect(probeAdd).toHaveBeenCalledTimes(1);
  });
  it("object not uploaded (HEAD throws) → 409 ObjectNotUploaded, no probe", async () => {
    headState.throws = true;
    const res = await post("/api/presign/confirm", { bucketId: BID, key: "k" });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("ObjectNotUploaded");
    expect(probeAdd).not.toHaveBeenCalled();
  });
  it("idempotent double-confirm (prior row equals HEAD size) → 200, no error", async () => {
    state.existingObject = { id: "obj-new", size: "1024" }; // same as headState.size
    const res = await post("/api/presign/confirm", { bucketId: BID, key: "k" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("confirmed");
  });
});
