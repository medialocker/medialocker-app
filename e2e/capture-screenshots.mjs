// Capture real screenshots of the running MediaLocker stack for the README.
//
// Prereq: the local stack is up + seeded (website :3000, dashboard :3001, API :3002,
// MinIO :9000) — e.g. via the dev bring-up. Self-contained: logs in as the seeded
// user, so it does NOT depend on a prior Playwright storageState.
//
// Usage:  cd e2e && node capture-screenshots.mjs
// Output: ../assets/screenshots/*.png
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "assets", "screenshots");
mkdirSync(OUT, { recursive: true });

const WEB = "http://localhost:3000";
const APP = "http://localhost:3001";
const EMAIL = "test@test.com";
const PASSWORD = "Test123!";
const VIEWPORT = { width: 1440, height: 900 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function settle(page, ms = 700) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {
    /* networkidle can hang on long-poll; fall through to the fixed settle */
  }
  await sleep(ms);
}

async function shoot(page, name, { fullPage = false } = {}) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage });
  console.log(`  ✓ ${name}.png`);
}

async function main() {
  const browser = await chromium.launch();

  // ---- Public pages (no session): website + login ----
  const pub = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  const p = await pub.newPage();

  await p.goto(`${WEB}/`, { waitUntil: "load" });
  await settle(p, 1200);
  await shoot(p, "website-home"); // hero fold (viewport) — clean leading banner

  await p.goto(`${WEB}/signup`, { waitUntil: "load" });
  await settle(p, 800);
  await shoot(p, "signup");

  await p.goto(`${APP}/login`, { waitUntil: "load" });
  await settle(p, 700);
  await shoot(p, "login");
  await pub.close();

  // ---- Authenticated dashboard ----
  const auth = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  const d = await auth.newPage();

  await d.goto(`${APP}/login`, { waitUntil: "load" });
  await d.locator('input[type="email"]').fill(EMAIL);
  await d.locator('input[autocomplete="current-password"]').fill(PASSWORD);
  await d.getByRole("button", { name: "Sign in" }).click();
  await d.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  console.log("  · logged in");

  // Media library (flagship) — give thumbnails extra time to paint.
  await d.goto(`${APP}/media`, { waitUntil: "load" });
  await settle(d, 1600);
  await shoot(d, "media-library");

  // Asset detail — click the first thumbnail to open the detail drawer.
  try {
    const firstTile = d.locator("main img, [class*='grid'] img").first();
    await firstTile.click({ timeout: 5000 });
    await sleep(1000);
    await shoot(d, "media-detail");
    await d.keyboard.press("Escape").catch(() => {});
  } catch (e) {
    console.log("  ! media-detail: could not open drawer —", e.message);
  }

  const pages = [
    ["buckets", "/buckets", 900],
    ["upload", "/upload", 700],
    ["organize", "/sets", 900],
    ["usage", "/usage", 1000],
    ["billing", "/billing", 1200],
    ["api-keys", "/api-keys", 800],
  ];
  for (const [name, route, ms] of pages) {
    await d.goto(`${APP}${route}`, { waitUntil: "load" });
    await settle(d, ms);
    await shoot(d, name);
  }

  // Search — type a seeded query so results show.
  await d.goto(`${APP}/search`, { waitUntil: "load" });
  await settle(d, 600);
  try {
    const box = d.getByPlaceholder(/search/i).first();
    await box.fill("hero");
    await box.press("Enter");
    await sleep(1200);
  } catch (e) {
    console.log("  ! search: query box not found —", e.message);
  }
  await shoot(d, "search");

  await auth.close();
  await browser.close();
  console.log(`\nDone → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
