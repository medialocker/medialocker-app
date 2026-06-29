import { test, expect } from "@playwright/test";

const WEB = "http://localhost:3000";

test.describe("marketing website", () => {
  test("home renders the hero", async ({ page }) => {
    await page.goto(WEB + "/");
    await expect(page.getByRole("heading", { name: /your media/i })).toBeVisible();
  });

  test("pricing page renders", async ({ page }) => {
    await page.goto(WEB + "/pricing");
    await expect(page.getByRole("heading", { name: /pricing/i }).first()).toBeVisible();
  });

  test("signup page renders", async ({ page }) => {
    await page.goto(WEB + "/signup");
    await expect(page.getByRole("heading", { name: /create your account/i })).toBeVisible();
  });
});
