import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config for the locally-running stack:
 *   dashboard  http://localhost:3001  (baseURL)
 *   website    http://localhost:3000  (absolute URLs in the website spec)
 *   api        http://localhost:3002
 *
 * Services are started outside Playwright (see scripts/dev-up.sh), so there is no
 * `webServer` block. The `setup` project logs in once as the seeded test user and
 * saves the Supabase session to storageState; the `dashboard` project reuses it.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: "http://localhost:3001",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "website",
      testMatch: /website\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "dashboard",
      testMatch: /dashboard\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "playwright/.auth/user.json",
      },
      dependencies: ["setup"],
    },
  ],
});
