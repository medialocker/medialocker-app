import { describe, it, expect } from "vitest";

/**
 * Live integration test against a booted control-plane stack (api + Postgres +
 * Redis + MinIO). Unlike the adapter contract test in apps/app — which mocks
 * fetch — this hits a real running api and asserts the *actual* response
 * envelopes the dashboard adapter depends on. It is read-only (no writes), so it
 * is safe to point at any seeded environment.
 *
 * It SKIPS unless both env vars are set, so it never blocks the default test run:
 *
 *   INTEGRATION_API_URL=http://localhost:3000 \
 *   INTEGRATION_API_TOKEN=<a valid Supabase user JWT for a seeded org> \
 *   pnpm --filter @medialocker/api test
 *
 * Bring the stack up first (infra/docker-compose.yml) and seed an org with at
 * least one bucket + API key (the webhook provisioning does this on checkout).
 */

const API = process.env.INTEGRATION_API_URL;
const TOKEN = process.env.INTEGRATION_API_TOKEN;
const enabled = Boolean(API && TOKEN);

// The write round-trip actually uploads + deletes bytes through the presign →
// gateway path, so it is gated behind an EXTRA explicit opt-in on top of the
// read-only env vars. It stays skipped unless you knowingly point it at a
// throwaway environment with INTEGRATION_ALLOW_WRITES=1.
const writesEnabled = enabled && process.env.INTEGRATION_ALLOW_WRITES === "1";

async function get(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function del(path: string): Promise<{ status: number }> {
  const res = await fetch(`${API}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  return { status: res.status };
}

describe.skipIf(!enabled)("control-plane live contract", () => {
  it("GET /api/buckets returns a {buckets:[]} envelope", async () => {
    const { status, json } = await get("/api/buckets");
    expect(status).toBe(200);
    expect(Array.isArray(json.buckets)).toBe(true);
    if (json.buckets.length > 0) {
      expect(json.buckets[0]).toHaveProperty("id");
      expect(json.buckets[0]).toHaveProperty("name");
    }
  });

  it("GET /api/usage exposes objectCount + the auto-capacity config block", async () => {
    const { status, json } = await get("/api/usage");
    expect(status).toBe(200);
    expect(json).toHaveProperty("used");
    expect(json).toHaveProperty("allocated");
    expect(json).toHaveProperty("objectCount");
    expect(json).toHaveProperty("autoCapacity");
    expect(json.autoCapacity).toHaveProperty("enabled");
    expect(json.autoCapacity).toHaveProperty("incrementGb");
    expect(json.autoCapacity).toHaveProperty("thresholdPct");
    expect(json.autoCapacity).toHaveProperty("maxMonthlySpendCents");
  });

  it("GET /api/api-keys surfaces the persisted name on each key", async () => {
    const { status, json } = await get("/api/api-keys");
    expect(status).toBe(200);
    expect(Array.isArray(json.keys)).toBe(true);
    for (const k of json.keys) {
      expect(k).toHaveProperty("name");
      expect(k).toHaveProperty("access_key_id");
    }
  });

  it("GET /api/tags and /api/categories return their list envelopes", async () => {
    const tags = await get("/api/tags");
    expect(tags.status).toBe(200);
    expect(Array.isArray(tags.json.tags)).toBe(true);

    const cats = await get("/api/categories");
    expect(cats.status).toBe(200);
    expect(Array.isArray(cats.json.categories)).toBe(true);
  });

  it("GET /api/storyboards returns a {storyboards:[]} envelope", async () => {
    const { status, json } = await get("/api/storyboards");
    expect(status).toBe(200);
    expect(Array.isArray(json.storyboards)).toBe(true);
  });
});

describe.skipIf(!writesEnabled)("control-plane write round-trip (presign → gateway)", () => {
  it("uploads, reads back, and deletes a small object through the real data plane", async () => {
    // Need a bucket to write into (provisioning seeds one on checkout).
    const buckets = await get("/api/buckets");
    expect(buckets.status).toBe(200);
    expect(buckets.json.buckets.length).toBeGreaterThan(0);
    const bucketId = buckets.json.buckets[0].id;

    const key = `integration/roundtrip-${Date.now()}.txt`;
    const payload = `hello ${Date.now()}`;

    // 1. Presign a PUT and upload the bytes straight to the gateway.
    const up = await post("/api/presign/upload", {
      bucketId,
      key,
      contentType: "text/plain",
      size: payload.length,
    });
    expect(up.status).toBe(200);
    expect(up.json.url).toBeTruthy();

    const putRes = await fetch(up.json.url, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: payload,
    });
    expect(putRes.ok).toBe(true);
    // The gateway must echo an ETag (and expose it via CORS for browsers).
    expect(putRes.headers.get("etag")).toBeTruthy();

    // 2. The object should now be listed; find its id by key.
    const list = await get(`/api/media?bucketId=${bucketId}`);
    expect(list.status).toBe(200);
    const row = (list.json.items as any[]).find((m) => m.key === key);
    expect(row, "uploaded object should appear in /media").toBeTruthy();

    // 3. Presign a download and verify the bytes survived the round-trip.
    const down = await post("/api/presign/download", { objectId: row.id });
    expect(down.status).toBe(200);
    const getRes = await fetch(down.json.url);
    expect(getRes.ok).toBe(true);
    expect(await getRes.text()).toBe(payload);

    // 4. Clean up so the test is repeatable.
    const deleted = await del(`/api/media/${row.id}`);
    expect([200, 204]).toContain(deleted.status);
  });
});
