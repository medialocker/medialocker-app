import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiClient } from "../lib/api";

/**
 * Integration contract test for the dashboard ↔ control-plane adapter (lib/api.ts).
 *
 * It does NOT spin up the real Fastify API — instead it mocks `fetch` with payloads
 * that mirror the *actual* response envelopes/field names emitted by apps/api/src/routes/*.
 * That locks the wire contract the adapter depends on: if either side drifts (envelope
 * shape, snake_case fields, request paths/bodies), these assertions fail. The canned
 * payloads below are copied from the route source — keep them in sync when routes change.
 */

type Call = {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
};

let calls: Call[];

/** Realistic backend responses, keyed loosely; mirrors apps/api route handlers. */
function route(method: string, path: string, ctx: { body: any }): unknown {
  // ── buckets ──
  if (method === "GET" && path === "/api/buckets")
    return {
      buckets: [
        {
          id: "b1",
          name: "renders",
          minio_bucket: "ml-x-renders",
          versioning_enabled: false,
          created_at: "2026-01-01T00:00:00Z",
          objectCount: 3,
          totalSize: "1500000000", // BigInt string from the route
        },
      ],
    };
  if (method === "POST" && path === "/api/buckets") return { id: "b2", name: ctx.body.name, minioBucket: "ml-x-new", endpoint: "new.s3.medialocker.io" };

  // ── media ──
  if (method === "GET" && path === "/api/media")
    return {
      items: [
        {
          id: "m1",
          bucket_id: "b1",
          key: "renders/clip.mp4",
          size: "2048",
          content_type: "video/mp4",
          created_at: "2026-01-02T00:00:00Z",
          bucket_name: "renders",
          kind: "video",
          width: 1920,
          height: 1080,
          duration_ms: 30000,
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    };
  if (method === "GET" && path === "/api/media/m1")
    return {
      id: "m1",
      bucket_id: "b1",
      key: "renders/clip.mp4",
      size: "2048",
      content_type: "video/mp4",
      created_at: "2026-01-02T00:00:00Z",
      bucket_name: "renders",
      kind: "video",
      width: 1920,
      height: 1080,
      duration_ms: 30000,
      metadata: {},
      tags: [{ id: "t1", name: "hero", slug: "hero" }],
    };
  if (method === "DELETE" && path === "/api/media/m1") return { status: "deleted" };
  // Thumbnail now returns JSON {url, expiresIn} — a presigned GET on Hetzner for
  // the preview derivative (NOT image bytes). Bytes-direct (§7.4).
  if (method === "GET" && path === "/api/media/m1/thumbnail")
    return { url: "https://ml-derived.s3.medialocker.io/thumb/m1.jpg?X-Amz-Signature=def", expiresIn: 86400 };
  // No derivative yet → the endpoint 404s; the adapter resolves it to null.
  if (method === "GET" && path === "/api/media/m404/thumbnail") return { __status: 404 };

  // ── tags ──
  if (method === "GET" && path === "/api/tags") return { tags: [{ id: "t1", name: "hero", slug: "hero", objectCount: 1 }] };
  if (method === "POST" && path === "/api/tags") return { id: "t2", name: ctx.body.name, slug: "wide" };
  if (method === "PUT" && path === "/api/objects/m1/tags") return { objectId: "m1", tags: [] };
  if (method === "DELETE" && path === "/api/tags/t1") return { status: "deleted" };

  // ── categories ──
  if (method === "GET" && path === "/api/categories")
    return {
      categories: [
        {
          id: "cat1",
          name: "Campaigns",
          parentId: null,
          objectCount: 5,
          children: [{ id: "cat2", name: "Q1", parentId: "cat1", objectCount: 2, children: [] }],
        },
      ],
    };
  if (method === "POST" && path === "/api/categories") return { id: "cat3", name: ctx.body.name, parentId: ctx.body.parentId ?? null };
  if (method === "DELETE" && path === "/api/categories/cat1") return { status: "deleted" };
  if (method === "PUT" && path === "/api/objects/m1/categories") return { objectId: "m1", categories: [] };

  // ── presign ──
  if (method === "POST" && path === "/api/presign/download")
    return { url: "https://renders.s3.medialocker.io/renders/clip.mp4?X-Amz-Signature=abc", method: "GET", objectId: ctx.body.objectId, key: "renders/clip.mp4", expiresIn: ctx.body.expiresIn };
  if (method === "POST" && path === "/api/presign/upload")
    return { url: "https://renders.s3.medialocker.io/" + ctx.body.key + "?put", method: "PUT", key: ctx.body.key, headers: {} };
  if (method === "POST" && path === "/api/presign/create-multipart")
    return { url: "https://renders.s3.medialocker.io/" + ctx.body.key + "?uploads", method: "POST", key: ctx.body.key, bucket: "renders", headers: {} };
  if (method === "POST" && path === "/api/presign/upload-part")
    return { url: "https://renders.s3.medialocker.io/" + ctx.body.key + "?partNumber=" + ctx.body.partNumber, method: "PUT", uploadId: ctx.body.uploadId, partNumber: ctx.body.partNumber, key: ctx.body.key };
  if (method === "POST" && path === "/api/presign/complete-upload")
    return { url: "https://renders.s3.medialocker.io/" + ctx.body.key + "?uploadId=" + ctx.body.uploadId, method: "POST", uploadId: ctx.body.uploadId, key: ctx.body.key, location: "https://renders.s3.medialocker.io/" + ctx.body.key };

  // ── sets ──
  if (method === "GET" && path === "/api/sets")
    return { sets: [{ id: "s1", name: "Hero Set", base_object_id: "m1", created_at: "2026-01-01T00:00:00Z", itemCount: 2 }] };
  if (method === "GET" && path === "/api/sets/s1")
    return {
      id: "s1",
      name: "Hero Set",
      base_object_id: "m1",
      created_at: "2026-01-01T00:00:00Z",
      items: [
        {
          id: "si1", // set_item join id
          set_id: "s1",
          object_id: "m1",
          aspect_ratio: "16:9",
          width: 1920,
          height: 1080,
          role: "base",
          object_key: "renders/clip.mp4",
          content_type: "video/mp4",
          bucket_name: "renders",
        },
      ],
    };
  if (method === "POST" && path === "/api/sets/s1/items") return { id: "si2", set_id: "s1", object_id: ctx.body.objectId };
  if (method === "DELETE" && path === "/api/sets/s1/items/si1") return { status: "deleted" };
  if (method === "POST" && path === "/api/sets/s1/generate") return { status: "enqueued", message: "queued", setId: "s1" };

  // ── storyboards ──
  if (method === "GET" && path === "/api/storyboards")
    return { storyboards: [{ id: "sb1", name: "Cut", created_at: "2026-01-01T00:00:00Z", clipCount: 2 }] };
  if (method === "GET" && path === "/api/storyboards/sb1")
    return {
      id: "sb1",
      name: "Cut",
      created_at: "2026-01-01T00:00:00Z",
      clips: [
        { id: "c1", object_id: "m1", position: 0, note: null, object_key: "renders/a.mp4", content_type: "video/mp4", bucket_name: "renders" },
        { id: "c2", object_id: "m2", position: 1, note: null, object_key: "renders/b.mp4", content_type: "video/mp4", bucket_name: "renders" },
      ],
    };
  if (method === "POST" && path === "/api/storyboards/sb1/clips") return { id: "c3", object_id: ctx.body.objectId, position: ctx.body.position };
  if (method === "PUT" && path === "/api/storyboards/sb1/clips/reorder")
    return { storyboardId: "sb1", clips: ctx.body.clipIds.map((id: string, i: number) => ({ id, object_id: id, position: i, note: null })) };
  if (method === "PUT" && /^\/api\/storyboards\/sb1\/clips\/c\d$/.test(path)) return { id: path.split("/").pop(), position: ctx.body.position };

  // ── usage / billing ──
  if (method === "GET" && path === "/api/usage")
    return {
      used: "1000000000", allocated: "5000000000", free: "4000000000",
      usedGb: 1, allocatedGb: 5, freeGb: 4, egress: 200, requests: 42, objectCount: 7,
      autoCapacity: { enabled: true, incrementGb: 50, thresholdPct: 75, maxMonthlySpendCents: 5000, spendThisCycleCents: 0 },
    };
  if (method === "POST" && path === "/api/billing/downgrade")
    return { tierKey: ctx.body.tierKey, planName: "Starter", newAllocatedGb: 100, message: "Downgraded to Starter" };
  if (method === "GET" && path === "/api/usage/history")
    return { history: [{ period: "2026-01", stored_bytes_max: "1000000000", egress_bytes: "200", request_count: "42" }] };
  if (method === "GET" && path === "/api/billing/subscription")
    return {
      subscription: {
        id: "sub1",
        stripe_subscription_id: "st1",
        plan_id: "p1",
        status: "active",
        current_period_end: "2026-07-01T00:00:00Z",
        plan_name: "Pro",
        planIncludedGb: 1000,
        planPriceCents: 2,
      },
      addons: [],
    };
  if (method === "POST" && path === "/api/billing/capacity/add") return { addedGb: ctx.body.gb, newAllocatedGb: 6 };
  if (method === "PUT" && path === "/api/billing/capacity/auto") return { autoCapacity: ctx.body };
  if (method === "GET" && path === "/api/billing/portal") return { url: "https://billing.stripe.com/session" };

  // ── api keys ──
  if (method === "GET" && path === "/api/api-keys")
    return {
      keys: [
        { id: "k1", name: "CI pipeline", access_key_id: "ml_abc", scopes: ["read"], bucket_scope: null, expires_at: "2026-09-01T00:00:00Z", last_used_at: null, revoked_at: null, created_at: "2026-01-01T00:00:00Z" },
      ],
    };
  if (method === "POST" && path === "/api/api-keys") return { id: "k2", name: ctx.body.name, accessKeyId: "ml_def", secret: "supersecret", scopes: ctx.body.scopes, expiresAt: "2026-09-01T00:00:00Z" };
  if (method === "PUT" && path === "/api/api-keys/k1/rotate") return { id: "k1", name: "CI pipeline", accessKeyId: "ml_abc", secret: "rotatedsecret", note: "store it" };

  // ── search ──
  if (method === "GET" && path === "/api/search")
    return {
      items: [
        { id: "m1", bucket_id: "b1", key: "renders/clip.mp4", size: "2048", content_type: "video/mp4", created_at: "2026-01-02T00:00:00Z", bucket_name: "renders", kind: "video", width: 1920, height: 1080, duration_ms: 30000 },
      ],
      total: 1,
      limit: 50,
      offset: 0,
      facets: { kinds: { video: 1 }, tags: { hero: 1 }, categories: { Campaigns: 1 }, sets: { "Hero Set": 1 }, storyboards: { Cut: 1 } },
    };

  throw new Error(`Unhandled mock route: ${method} ${path}`);
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const raw = typeof input === "string" ? input : input.url;
    // §2.6 — the adapter now targets the same-origin server proxy
    // (/api/proxy/<control-plane-path>). Resolve against a dummy origin and strip
    // the proxy prefix so these contract assertions still read the real
    // control-plane path the proxy forwards to.
    const url = new URL(raw, "http://proxy.test");
    const path = url.pathname.replace(/^\/api\/proxy/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, query: Object.fromEntries(url.searchParams), body });
    const payload = route(method, path, { body });
    // A `{ __status }` marker lets a route model a non-2xx response (e.g. a 404
    // thumbnail before the derivative exists) so the adapter's `!res.ok` paths run.
    if (payload && typeof payload === "object" && "__status" in (payload as any)) {
      const status = (payload as any).__status as number;
      return { ok: false, status, text: async () => "", json: async () => ({}) } as Response;
    }
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const last = (method: string, pathIncludes: string) =>
  calls.filter((c) => c.method === method && c.path.includes(pathIncludes)).at(-1);

describe("buckets", () => {
  it("unwraps the {buckets} envelope and coerces numeric fields", async () => {
    const buckets = await apiClient.buckets.list();
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ id: "b1", name: "renders", objectCount: 3, totalSize: 1500000000 });
    expect(typeof buckets[0]!.totalSize).toBe("number");
  });
});

describe("media", () => {
  it("lists via /api/media?bucketId= and maps key→filename, content_type→mimeType, ms→seconds", async () => {
    const res = await apiClient.media.list("b1", { type: "video" });
    const req = last("GET", "/api/media");
    expect(req!.query).toMatchObject({ bucketId: "b1", kind: "video", limit: "50" });
    expect(res.total).toBe(1);
    expect(res.hasMore).toBe(false);
    expect(res.data[0]).toMatchObject({ id: "m1", filename: "clip.mp4", mimeType: "video/mp4", duration: 30, size: 2048 });
  });

  it("maps a single item's tag objects to string names", async () => {
    const m = await apiClient.media.get("m1");
    expect(m.filename).toBe("clip.mp4");
    expect(m.tags).toEqual(["hero"]);
  });

  it("setting tags resolves names→ids (find + create) then PUTs /objects/:id/tags", async () => {
    await apiClient.media.update("m1", { tags: ["hero", "wide"] });
    expect(last("GET", "/api/tags")).toBeTruthy(); // looked up existing
    expect(last("POST", "/api/tags")!.body).toEqual({ name: "wide" }); // created the missing one
    expect(last("PUT", "/api/objects/m1/tags")!.body).toEqual({ tagIds: ["t1", "t2"] });
  });

  it("presignDownload posts the object id and returns a presigned (bytes-direct) GET url", async () => {
    const r = await apiClient.media.presignDownload("m1");
    expect(last("POST", "/api/presign/download")!.body).toEqual({ objectId: "m1", expiresIn: 3600 });
    // The url points straight at Hetzner storage — the browser fetches bytes
    // directly, never through our proxy/server.
    expect(r.url).toContain("X-Amz-Signature");
    expect(r.method).toBe("GET");
    expect(r.objectId).toBe("m1");
  });

  it("thumbnailUrl GETs JSON {url} from the proxy and returns the presigned URL (no blob fetch)", async () => {
    const url = await apiClient.media.thumbnailUrl("m1");
    // Resolved via the authed GET /media/:id/thumbnail JSON endpoint (through the proxy).
    expect(last("GET", "/api/media/m1/thumbnail")).toBeTruthy();
    // The returned value is the presigned Hetzner URL used directly as an <img src>.
    expect(url).toBe("https://ml-derived.s3.medialocker.io/thumb/m1.jpg?X-Amz-Signature=def");
  });

  it("thumbnailUrl resolves to null when no derivative exists yet (404)", async () => {
    const url = await apiClient.media.thumbnailUrl("m404");
    expect(url).toBeNull();
  });
});

describe("sets", () => {
  it("maps join-row items to Media + setItemId", async () => {
    const set = await apiClient.sets.get("s1");
    expect(set.baseAssetId).toBe("m1");
    expect(set.variantCount).toBe(1);
    const item = set.items[0]!;
    expect(item.id).toBe("m1"); // object id, used for navigation
    expect(item.setItemId).toBe("si1"); // join id, used for removal
    expect(item.filename).toBe("clip.mp4");
  });

  it("addItem sends {objectId}; removeItem keys on the set_item id", async () => {
    await apiClient.sets.addItem("s1", "m1");
    expect(last("POST", "/api/sets/s1/items")!.body).toEqual({ objectId: "m1" });
    await apiClient.sets.removeItem("s1", "si1");
    expect(last("DELETE", "/api/sets/s1/items/si1")).toBeTruthy();
  });
});

describe("storyboards", () => {
  it("maps clips to {id, mediaId, order, media}", async () => {
    const sb = await apiClient.storyboards.get("sb1");
    expect(sb.clips).toHaveLength(2);
    expect(sb.clips[0]).toMatchObject({ id: "c1", mediaId: "m1", order: 0 });
    expect(sb.clips[0]!.media.filename).toBe("a.mp4");
  });

  it("addClip sends {objectId, position}", async () => {
    await apiClient.storyboards.addClip("sb1", "m1", 2);
    expect(last("POST", "/api/storyboards/sb1/clips")!.body).toEqual({ objectId: "m1", position: 2 });
  });

  it("reorder persists the whole order in one bulk PUT", async () => {
    await apiClient.storyboards.reorder("sb1", ["c2", "c1"]);
    const puts = calls.filter((c) => c.method === "PUT" && c.path.includes("/clips/"));
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ path: "/api/storyboards/sb1/clips/reorder", body: { clipIds: ["c2", "c1"] } });
  });
});

describe("usage & billing", () => {
  it("maps usage byte strings to numbers and surfaces objectCount", async () => {
    const u = await apiClient.usage.get();
    expect(u).toMatchObject({ usedStorage: 1000000000, allocatedStorage: 5000000000, egressThisMonth: 200, apiCallsThisMonth: 42, objectCount: 7 });
  });

  it("assembles billing from /usage + /billing/subscription incl. real auto-capacity (cents→dollars)", async () => {
    const b = await apiClient.billing.get();
    expect(b.plan).toBe("Pro");
    expect(b.baseStorage).toBe(1000 * 1e9);
    expect(b.overageRate).toBeCloseTo(0.02);
    expect(b.currentUsage).toBe(1000000000);
    expect(b.renewsAt).toBe("2026-07-01T00:00:00Z");
    expect(b.autoCapacity).toBe(true);
    expect(b.autoCapacityConfig).toEqual({ increment: 50, threshold: 75, maxSpend: 50 });
  });

  it("auto-capacity write maps to backend field names and dollars→cents", async () => {
    await apiClient.billing.updateAutoCapacity({ enabled: true, increment: 100, threshold: 80, maxSpend: 50 });
    expect(last("PUT", "/api/billing/capacity/auto")!.body).toEqual({
      enabled: true,
      incrementGb: 100,
      thresholdPct: 80,
      maxMonthlySpendCents: 5000,
    });
  });

  it("downgrade posts the target tier key", async () => {
    const res = await apiClient.billing.downgrade("starter");
    expect(last("POST", "/api/billing/downgrade")!.body).toEqual({ tierKey: "starter" });
    expect(res.message).toBe("Downgraded to Starter");
  });
});

describe("api keys", () => {
  it("unwraps {keys}, surfaces the persisted name, and access_key_id as prefix", async () => {
    const keys = await apiClient.apiKeys.list();
    expect(keys[0]).toMatchObject({ id: "k1", name: "CI pipeline", prefix: "ml_abc", scopes: ["read"] });
  });

  it("create returns {key, secret} with the persisted name", async () => {
    const { key, secret } = await apiClient.apiKeys.create({ name: "CI key", scopes: ["read", "write"] });
    expect(secret).toBe("supersecret");
    expect(key).toMatchObject({ name: "CI key", prefix: "ml_def", scopes: ["read", "write"] });
  });

  it("rotate returns the new secret keeping the key's name", async () => {
    const { key, secret } = await apiClient.apiKeys.rotate("k1");
    expect(secret).toBe("rotatedsecret");
    expect(key).toMatchObject({ id: "k1", name: "CI pipeline", prefix: "ml_abc" });
  });
});

describe("tags", () => {
  it("lists tags with object counts and deletes by id", async () => {
    const tags = await apiClient.tags.list();
    expect(tags[0]).toMatchObject({ id: "t1", name: "hero", objectCount: 1 });
    await apiClient.tags.delete("t1");
    expect(last("DELETE", "/api/tags/t1")).toBeTruthy();
  });
});

describe("categories", () => {
  it("maps the hierarchical {categories} tree (parentId + children)", async () => {
    const cats = await apiClient.categories.list();
    expect(cats).toHaveLength(1);
    expect(cats[0]).toMatchObject({ id: "cat1", name: "Campaigns", parentId: null, objectCount: 5 });
    expect(cats[0]!.children[0]).toMatchObject({ id: "cat2", name: "Q1", parentId: "cat1" });
  });

  it("create sends {name, parentId}; setForObject PUTs categoryIds", async () => {
    await apiClient.categories.create("Promos", "cat1");
    expect(last("POST", "/api/categories")!.body).toEqual({ name: "Promos", parentId: "cat1" });
    await apiClient.categories.setForObject("m1", ["cat1", "cat2"]);
    expect(last("PUT", "/api/objects/m1/categories")!.body).toEqual({ categoryIds: ["cat1", "cat2"] });
  });
});

describe("search", () => {
  it("maps {items, facets:{kinds,tags,categories,sets,storyboards}} to {media, facets:{types,tags,categories,sets,storyboards}}", async () => {
    const r = await apiClient.search.query("clip", { type: "video" });
    const req = last("GET", "/api/search");
    expect(req!.query).toMatchObject({ q: "clip", kind: "video" });
    expect(r.media[0]!.filename).toBe("clip.mp4");
    expect(r.facets.types).toEqual([{ key: "video", count: 1 }]);
    expect(r.facets.tags).toEqual([{ key: "hero", count: 1 }]);
    expect(r.facets.categories).toEqual([{ key: "Campaigns", count: 1 }]);
    expect(r.facets.sets).toEqual([{ key: "Hero Set", count: 1 }]);
    expect(r.facets.storyboards).toEqual([{ key: "Cut", count: 1 }]);
  });
});
