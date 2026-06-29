import { describe, it, expect, beforeAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

// The bucket-create route imports the S3 client at module load; stub it so the
// route modules register without a live MinIO (mirrors routes.test.ts).
import { vi } from "vitest";
vi.mock("../lib/s3.js", () => ({
  getS3: () => ({ send: async () => ({}) }),
  refreshS3Client: async () => ({ send: async () => ({}) }),
  DERIVED_BUCKET: "ml-derived",
}));

import { buildOpenApiSpec } from "../openapi.js";

/**
 * P3.1 — OpenAPI drift guard.
 *
 * apps/api/src/openapi.ts is a HAND-MAINTAINED document, so it silently drifts
 * from the real route table as routes are added/removed. This test boots every
 * route module onto a throwaway Fastify instance, captures the actual registered
 * (method, path) pairs via the `onRoute` hook, and asserts that each one is
 * present in the OpenAPI spec. If a route is added without a matching spec entry
 * (or a path/method changes), this test FAILS — forcing the doc back in sync.
 */

interface RouteEntry {
  method: string;
  url: string;
}

// Fastify path params look like `/media/:id`; OpenAPI uses `/media/{id}`. Both
// are also registered under the `/api` prefix, while the spec paths are written
// WITHOUT it (the `servers[].url` carries the `/api` base). Normalize to compare.
function fastifyToOpenApiPath(url: string): string {
  return url
    .replace(/^\/api/, "")
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

// Routes that are intentionally NOT part of the documented public surface.
const UNDOCUMENTED = new Set<string>([
  "GET /api/health",
  "GET /api/plans",
  "GET /api/openapi.json",
]);

let routes: RouteEntry[] = [];

beforeAll(async () => {
  const app: FastifyInstance = Fastify({ logger: false });

  app.addHook("onRoute", (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const m of methods) {
      // Fastify auto-registers HEAD for GET routes; ignore it.
      if (m === "HEAD") continue;
      routes.push({ method: m, url: routeOptions.url });
    }
  });

  const { authRoutes } = await import("../routes/auth.js");
  const { bucketRoutes } = await import("../routes/buckets.js");
  const { mediaRoutes } = await import("../routes/media.js");
  const { tagRoutes } = await import("../routes/tags.js");
  const { categoryRoutes } = await import("../routes/categories.js");
  const { setRoutes } = await import("../routes/sets.js");
  const { storyboardRoutes } = await import("../routes/storyboards.js");
  const { searchRoutes } = await import("../routes/search.js");
  const { usageRoutes } = await import("../routes/usage.js");
  const { presignRoutes } = await import("../routes/presign.js");
  const { webhookRoutes } = await import("../routes/webhook.js");
  const { openapiRoutes } = await import("../openapi.js");

  await app.register(authRoutes, { prefix: "/api" });
  await app.register(bucketRoutes, { prefix: "/api" });
  await app.register(mediaRoutes, { prefix: "/api" });
  await app.register(tagRoutes, { prefix: "/api" });
  await app.register(categoryRoutes, { prefix: "/api" });
  await app.register(setRoutes, { prefix: "/api" });
  await app.register(storyboardRoutes, { prefix: "/api" });
  await app.register(searchRoutes, { prefix: "/api" });
  await app.register(usageRoutes, { prefix: "/api" });
  await app.register(presignRoutes, { prefix: "/api" });
  await app.register(webhookRoutes, { prefix: "/api" });
  await app.register(openapiRoutes, { prefix: "/api" });

  await app.ready();
  await app.close();
});

describe("OpenAPI drift guard", () => {
  it("registers at least the core routes", () => {
    expect(routes.length).toBeGreaterThan(10);
  });

  it("documents every registered route in the OpenAPI spec", () => {
    const spec = buildOpenApiSpec() as { paths: Record<string, Record<string, unknown>> };
    const missing: string[] = [];

    for (const route of routes) {
      const key = `${route.method} ${route.url}`;
      if (UNDOCUMENTED.has(key)) continue;

      const specPath = fastifyToOpenApiPath(route.url);
      const pathItem = spec.paths[specPath];
      const method = route.method.toLowerCase();

      if (!pathItem || !(method in pathItem)) {
        missing.push(`${route.method} ${specPath}`);
      }
    }

    expect(
      missing,
      `Routes missing from openapi.ts (add them to buildOpenApiSpec): ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
