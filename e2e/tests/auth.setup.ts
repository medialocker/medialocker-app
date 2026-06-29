import { test as setup, expect } from "@playwright/test";

const authFile = "playwright/.auth/user.json";

/**
 * Log in once as the seeded test user (test@test.com / Test123!) through the real
 * Supabase-backed login form, then persist the session for the dashboard project.
 */
setup("authenticate", async ({ page }) => {
  await page.goto("/login");

  await page.locator('input[type="email"]').fill("test@test.com");
  await page.locator('input[autocomplete="current-password"]').fill("Test123!");
  await page.getByRole("button", { name: "Sign in" }).click();

  // On success the app routes to "/" (dashboard). Wait until we leave /login.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });

  // Sanity: no auth error surfaced.
  await expect(page.getByText(/invalid email or password/i)).toHaveCount(0);

  await page.context().storageState({ path: authFile });
});
