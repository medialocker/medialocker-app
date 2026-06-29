import { test, expect } from "@playwright/test";

/**
 * Dashboard screen coverage against the seeded "Test Studio" org. Uses the
 * stored Supabase session (see auth.setup.ts) and asserts on seeded data so the
 * checks prove real end-to-end rendering (proxy → API → Supabase → MinIO).
 */

test("lands on the dashboard after login (not /login)", async ({ page }) => {
  await page.goto("/");
  await expect(page).not.toHaveURL(/\/login/);
  // Sidebar navigation is present.
  await expect(page.getByText("Buckets", { exact: true }).first()).toBeVisible();
});

test("buckets screen shows the three seeded buckets", async ({ page }) => {
  await page.goto("/buckets");
  // exact:true — the bucket name also appears in the "<name>.s3.localhost" endpoint cell.
  await expect(page.getByText("Brand Assets", { exact: true })).toBeVisible();
  await expect(page.getByText("Campaign Media", { exact: true })).toBeVisible();
  await expect(page.getByText("Product Shots", { exact: true })).toBeVisible();
  // object counts rendered from the API
  await expect(page.getByRole("row", { name: /Brand Assets.*\b8\b/ })).toBeVisible();
});

test("media library lists seeded objects", async ({ page }) => {
  await page.goto("/media");
  // Tiles are labelled by object key basename (e.g. "01-front-view.png").
  await expect(page.getByText(/front-view|spec-sheet|360-spin/i).first()).toBeVisible();
});

test("search finds seeded media", async ({ page }) => {
  await page.goto("/search");
  const box = page.getByPlaceholder(/search/i).first();
  await box.fill("hero");
  await box.press("Enter");
  await expect(page.getByText(/hero-banner/i).first()).toBeVisible();
});

test("organize shows seeded sets and storyboards", async ({ page }) => {
  await page.goto("/sets");
  await expect(page.getByText("Hero Banner Variants")).toBeVisible();
  await page.getByRole("button", { name: /storyboards/i }).first().click();
  await expect(page.getByText("Launch Promo")).toBeVisible();
});

test("usage screen renders", async ({ page }) => {
  await page.goto("/usage");
  await expect(page.getByText(/usage/i).first()).toBeVisible();
});

test("billing screen shows the Pro plan", async ({ page }) => {
  await page.goto("/billing");
  await expect(page.getByText(/billing/i).first()).toBeVisible();
  await expect(page.getByText(/\bpro\b/i).first()).toBeVisible();
});

test("api keys screen shows the seeded key", async ({ page }) => {
  await page.goto("/api-keys");
  await expect(page.getByText("Local Dev Key")).toBeVisible();
});

test("upload screen renders", async ({ page }) => {
  await page.goto("/upload");
  await expect(page.getByText(/upload/i).first()).toBeVisible();
});
