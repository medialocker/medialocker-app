import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Integration-only vitest config. It is INTENTIONALLY separate from every
 * package's own vitest.config.ts and lives under tests/integration/ so that the
 * root `pnpm test` (turbo run test, which only invokes each package's own
 * `vitest run`) NEVER picks these up. They run solely via the root
 * `pnpm test:integration` script, which targets this config file.
 *
 * `@medialocker/*` imports are aliased to the packages' TS source so the suite
 * exercises the same code the apps ship, transpiled on the fly by vitest — no
 * dependency on a prior `pnpm build` of dist, and no need for this directory to
 * be a pnpm workspace member.
 */
function pkg(rel: string): string {
  return fileURLToPath(new URL(`../../packages/${rel}`, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      "@medialocker/config": pkg("config/src/index.ts"),
      "@medialocker/core": pkg("core/src/index.ts"),
      "@medialocker/db": pkg("db/src/index.ts"),
      "@medialocker/billing": pkg("billing/src/index.ts"),
    },
  },
  test: {
    include: ["suites/**/*.test.ts"],
    // One worker process: these tests touch a shared external store (Postgres).
    // Each test seeds its OWN isolated org/bucket so they don't collide, but
    // running single-forked keeps capacity-concurrency assertions deterministic
    // and avoids connection-pool thrash against the test stack.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    globalSetup: ["./scripts/setup.ts"],
    setupFiles: ["./scripts/vitest.setup.ts"],
    // Bringing up clients + real round-trips is slower than unit tests.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
