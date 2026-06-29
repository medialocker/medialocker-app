/**
 * Dev seed — a full, realistic tenant for local UI/e2e testing.
 *
 * Creates (idempotently):
 *   - Supabase Auth user  test@test.com / Test123!  (admin API)
 *   - app users row (id = auth sub), organization, owner membership
 *   - plans + active subscription + capacity
 *   - 3 buckets (+ real MinIO buckets) and ~30 objects across image/video/audio/pdf
 *   - generated thumbnails (in ml-derived) and object bytes (in the tenant bucket)
 *     so the media library + detail views render real previews
 *   - tags, categories (with a parent/child), sets (variants), storyboards (clips)
 *   - usage history (events + 30-day rollups) and one REST API key
 *
 * Re-running wipes the test org (ON DELETE CASCADE) and rebuilds it, keeping the
 * same Supabase auth user. Run with the SSL-normalized DATABASE_URL in env (the
 * local run scripts handle that).
 */
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";
import postgres from "postgres";
import { getConfig } from "@medialocker/config";
import { createApiKey } from "@medialocker/auth";

const TEST_EMAIL = "test@test.com";
const TEST_PASSWORD = "Test123!";
const DERIVED_BUCKET = "ml-derived";

const cfg = getConfig();

const s3 = new S3Client({
  endpoint: cfg.HETZNER_S3_ENDPOINT,
  region: cfg.HETZNER_S3_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: cfg.HETZNER_S3_ACCESS_KEY,
    secretAccessKey: cfg.HETZNER_S3_SECRET_KEY,
  },
});

const sql = postgres(cfg.DATABASE_URL, {
  max: 2,
  idle_timeout: 5,
  connect_timeout: 15,
});

// ---------- Supabase Admin (REST, no SDK) ------------------------------------

function adminHeaders(): Record<string, string> {
  const key = cfg.SUPABASE_SECRET_KEY!;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

/** Create the test auth user (or fetch it if it already exists). Returns its uid. */
async function ensureAuthUser(appMetadata: Record<string, unknown>): Promise<string> {
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SECRET_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set to seed the auth user.");
  }
  const base = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/users`;

  // Try to create first.
  const createRes = await fetch(base, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      app_metadata: appMetadata,
    }),
  });

  if (createRes.ok) {
    const user = (await createRes.json()) as { id: string };
    return user.id;
  }

  // Already exists (or other) → find by listing, then update password + metadata.
  const listRes = await fetch(`${base}?page=1&per_page=200`, { headers: adminHeaders() });
  if (!listRes.ok) {
    throw new Error(`Supabase admin createUser failed (${createRes.status}) and list failed (${listRes.status})`);
  }
  const list = (await listRes.json()) as { users?: Array<{ id: string; email: string }> };
  const existing = (list.users ?? []).find((u) => u.email?.toLowerCase() === TEST_EMAIL);
  if (!existing) {
    throw new Error(`Could not create or find auth user ${TEST_EMAIL} (create status ${createRes.status})`);
  }
  // Reset password + confirm + refresh app_metadata so reseeds stay consistent.
  await fetch(`${base}/${existing.id}`, {
    method: "PUT",
    headers: adminHeaders(),
    body: JSON.stringify({
      password: TEST_PASSWORD,
      email_confirm: true,
      app_metadata: appMetadata,
    }),
  });
  return existing.id;
}

async function setAuthUserOrg(uid: string, orgId: string): Promise<void> {
  const base = `${cfg.SUPABASE_URL!.replace(/\/$/, "")}/auth/v1/admin/users/${uid}`;
  await fetch(base, {
    method: "PUT",
    headers: adminHeaders(),
    body: JSON.stringify({ app_metadata: { org_id: orgId } }),
  });
}

// ---------- Asset generation -------------------------------------------------

const PALETTE = ["#6d5ef6", "#a78bfa", "#22d3ee", "#f59e0b", "#ef4444", "#10b981", "#ec4899", "#3b82f6"];

function svgImage(w: number, h: number, label: string, sub: string, color: string): Buffer {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
       <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0%" stop-color="${color}"/><stop offset="100%" stop-color="#0a0a0f"/>
       </linearGradient></defs>
       <rect width="100%" height="100%" fill="url(#g)"/>
       <text x="50%" y="48%" font-family="Inter, sans-serif" font-size="${Math.round(h / 8)}"
         fill="#ffffff" text-anchor="middle" font-weight="700">${esc(label)}</text>
       <text x="50%" y="62%" font-family="Inter, sans-serif" font-size="${Math.round(h / 18)}"
         fill="#ffffffcc" text-anchor="middle">${esc(sub)}</text>
     </svg>`,
  );
}

async function pngFromSvg(svg: Buffer): Promise<Buffer> {
  return sharp(svg).png().toBuffer();
}

async function ensureBucket(name: string): Promise<void> {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: name }));
  } catch (err: unknown) {
    const code = (err as { name?: string; Code?: string })?.name ?? (err as { Code?: string })?.Code;
    if (code !== "BucketAlreadyOwnedByYou" && code !== "BucketAlreadyExists") throw err;
  }
}

async function putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

// ---------- Data model -------------------------------------------------------

type Kind = "image" | "video" | "audio" | "pdf";

interface SeedObject {
  name: string;
  key: string;
  kind: Kind;
  size: number;
  contentType: string;
  width?: number;
  height?: number;
  durationMs?: number;
  tags: string[];
  category?: string;
}

const KIND_CT: Record<Kind, string> = {
  image: "image/png",
  video: "video/mp4",
  audio: "audio/mpeg",
  pdf: "application/pdf",
};

function mb(n: number): number {
  return Math.round(n * 1024 * 1024);
}

/** Build the object spec list for a bucket. */
function buildObjects(prefix: string, specs: Array<Partial<SeedObject> & { name: string; kind: Kind }>): SeedObject[] {
  return specs.map((s, i) => {
    const ext = s.kind === "image" ? "png" : s.kind === "video" ? "mp4" : s.kind === "audio" ? "mp3" : "pdf";
    const key = `${prefix}/${String(i + 1).padStart(2, "0")}-${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.${ext}`;
    const base: SeedObject = {
      name: `${s.name}.${ext}`,
      key,
      kind: s.kind,
      size: s.size ?? (s.kind === "image" ? mb(2 + (i % 4)) : s.kind === "video" ? mb(40 + i * 12) : s.kind === "audio" ? mb(4 + (i % 5)) : mb(1)),
      contentType: KIND_CT[s.kind],
      width: s.kind === "image" || s.kind === "video" ? (s.width ?? 1920) : undefined,
      height: s.kind === "image" || s.kind === "video" ? (s.height ?? 1080) : undefined,
      durationMs: s.kind === "video" ? (s.durationMs ?? (15000 + i * 5000)) : s.kind === "audio" ? (s.durationMs ?? (120000 + i * 30000)) : undefined,
      tags: s.tags ?? [],
      category: s.category,
    };
    return base;
  });
}

async function main(): Promise<void> {
  console.log("Seeding dev data…");

  // 1) Plans (global pricing) — ensure present.
  const PLANS = [
    { tier_key: "starter", name: "Starter", included_gb: 100, per_gb_price_cents: 2 },
    { tier_key: "pro", name: "Pro", included_gb: 1000, per_gb_price_cents: 2 },
    { tier_key: "studio", name: "Studio", included_gb: 5000, per_gb_price_cents: 2 },
  ];
  for (const p of PLANS) {
    await sql`
      INSERT INTO plans (tier_key, name, included_gb, per_gb_price_cents)
      VALUES (${p.tier_key}, ${p.name}, ${p.included_gb}, ${p.per_gb_price_cents})
      ON CONFLICT (tier_key) DO UPDATE SET name = EXCLUDED.name, included_gb = EXCLUDED.included_gb`;
  }
  const [starter] = await sql<{ id: string }[]>`SELECT id FROM plans WHERE tier_key = 'pro' LIMIT 1`;
  const planId = starter!.id;

  // 2) Auth user (idempotent).
  const uid = await ensureAuthUser({});
  console.log(`  auth user: ${TEST_EMAIL} (${uid})`);

  // 3) Wipe prior app data for this user, then rebuild. Deleting the org cascades
  //    to buckets/objects/tags/sets/storyboards/usage/etc.
  await sql`DELETE FROM organizations WHERE id IN (
    SELECT org_id FROM memberships WHERE user_id = ${uid}
  )`;
  await sql`DELETE FROM users WHERE id = ${uid}`;

  // 4) Core tenancy.
  await sql`INSERT INTO users (id, email, name) VALUES (${uid}, ${TEST_EMAIL}, ${"Test User"})`;
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES (${"Test Studio"}, ${"test-studio"}) RETURNING id`;
  const orgId = org!.id;
  await sql`INSERT INTO memberships (org_id, user_id, role) VALUES (${orgId}, ${uid}, 'owner')`;
  await setAuthUserOrg(uid, orgId);

  // 5) Subscription + capacity.
  await sql`
    INSERT INTO subscriptions (org_id, stripe_subscription_id, stripe_customer_id, plan_id, status, current_period_end)
    VALUES (${orgId}, ${`sub_seed_${orgId.slice(0, 8)}`}, ${`cus_seed_${orgId.slice(0, 8)}`}, ${planId}, 'active', ${new Date(Date.now() + 30 * 864e5).toISOString()})`;

  // 6) Buckets + objects.
  await ensureBucket(DERIVED_BUCKET);

  const buckets = [
    {
      name: "Brand Assets",
      minio: "ml-test-brand-assets",
      objects: buildObjects("brand", [
        { name: "Primary Logo", kind: "image", tags: ["brand", "approved"], category: "Product" },
        { name: "Logo Mono", kind: "image", tags: ["brand", "approved"], category: "Product" },
        { name: "Wordmark", kind: "image", tags: ["brand"], category: "Product" },
        { name: "App Icon", kind: "image", tags: ["brand", "approved"], category: "Product" },
        { name: "Brand Guidelines", kind: "pdf", tags: ["brand", "approved"], category: "Product" },
        { name: "Color Swatches", kind: "image", tags: ["brand"], category: "Product" },
        { name: "Typography Sheet", kind: "image", tags: ["brand", "draft"], category: "Product" },
        { name: "Press Kit", kind: "pdf", tags: ["brand"], category: "Product" },
      ]),
    },
    {
      name: "Campaign Media",
      minio: "ml-test-campaign-media",
      objects: buildObjects("campaign", [
        { name: "Hero Banner", kind: "image", tags: ["hero", "social", "approved"], category: "Summer 2024" },
        { name: "Hero Banner Mobile", kind: "image", tags: ["hero", "social"], category: "Summer 2024" },
        { name: "Launch Teaser", kind: "video", tags: ["hero", "social", "approved"], category: "Summer 2024" },
        { name: "Behind The Scenes", kind: "video", tags: ["behind-the-scenes"], category: "Summer 2024" },
        { name: "Product Reveal", kind: "video", tags: ["hero", "approved"], category: "Winter 2024" },
        { name: "Testimonial Clip", kind: "video", tags: ["social"], category: "Winter 2024" },
        { name: "Radio Spot", kind: "audio", tags: ["social"], category: "Summer 2024" },
        { name: "Podcast Ad", kind: "audio", tags: ["social", "draft"], category: "Winter 2024" },
        { name: "Social Square", kind: "image", tags: ["social", "approved"], category: "Summer 2024" },
        { name: "Social Story", kind: "image", tags: ["social"], category: "Summer 2024" },
        { name: "Email Header", kind: "image", tags: ["social", "draft"], category: "Winter 2024" },
        { name: "Campaign Brief", kind: "pdf", tags: ["draft"], category: "Winter 2024" },
      ]),
    },
    {
      name: "Product Shots",
      minio: "ml-test-product-shots",
      objects: buildObjects("product", [
        { name: "Front View", kind: "image", tags: ["approved"], category: "Product" },
        { name: "Back View", kind: "image", tags: ["approved"], category: "Product" },
        { name: "Side View", kind: "image", tags: ["approved"], category: "Product" },
        { name: "Detail Macro", kind: "image", tags: ["draft"], category: "Product" },
        { name: "Lifestyle 1", kind: "image", tags: ["social", "approved"], category: "Social" },
        { name: "Lifestyle 2", kind: "image", tags: ["social"], category: "Social" },
        { name: "Packaging", kind: "image", tags: ["approved"], category: "Product" },
        { name: "Unboxing", kind: "video", tags: ["social"], category: "Social" },
        { name: "360 Spin", kind: "video", tags: ["approved"], category: "Product" },
        { name: "Spec Sheet", kind: "pdf", tags: ["approved"], category: "Product" },
      ]),
    },
  ];

  // Tag + category registries (created lazily, deduped per org).
  const tagIds = new Map<string, string>();
  async function tagId(name: string): Promise<string> {
    if (tagIds.has(name)) return tagIds.get(name)!;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO tags (org_id, name, slug) VALUES (${orgId}, ${name}, ${slug}) RETURNING id`;
    tagIds.set(name, row!.id);
    return row!.id;
  }

  // Categories: a parent "Campaigns" with children, plus flat Product/Social.
  const [campaigns] = await sql<{ id: string }[]>`
    INSERT INTO categories (org_id, name, slug) VALUES (${orgId}, ${"Campaigns"}, ${"campaigns"}) RETURNING id`;
  const catIds = new Map<string, string>();
  async function categoryId(name: string): Promise<string> {
    if (catIds.has(name)) return catIds.get(name)!;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const isCampaignChild = name.endsWith("2024");
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO categories (org_id, name, slug, parent_id)
      VALUES (${orgId}, ${name}, ${slug}, ${isCampaignChild ? campaigns!.id : null}) RETURNING id`;
    catIds.set(name, row!.id);
    return row!.id;
  }

  let objectCount = 0;
  let totalBytes = 0;
  const imageObjectIds: string[] = [];
  const videoObjectIds: string[] = [];

  for (const b of buckets) {
    await ensureBucket(b.minio);
    const [bucketRow] = await sql<{ id: string }[]>`
      INSERT INTO buckets (org_id, name, minio_bucket) VALUES (${orgId}, ${b.name}, ${b.minio}) RETURNING id`;
    const bucketId = bucketRow!.id;

    for (const o of b.objects) {
      const color = PALETTE[objectCount % PALETTE.length]!;
      // Object bytes (full asset for images; small placeholder for others).
      const fullPng = await pngFromSvg(svgImage(o.width ?? 1024, o.height ?? 768, o.name.replace(/\.[a-z0-9]+$/, ""), o.kind.toUpperCase(), color));
      await putObject(b.minio, o.key, fullPng, o.contentType);

      // Thumbnail derivative in ml-derived (drives the media library grid).
      const thumb = await pngFromSvg(svgImage(320, 240, o.name.replace(/\.[a-z0-9]+$/, ""), o.kind.toUpperCase(), color));
      const thumbKey = `thumbnails/${b.minio}/${o.key.split("/").pop()}.png`;

      const etag = `"${objectCount.toString(16).padStart(32, "0")}"`;
      const [objRow] = await sql<{ id: string }[]>`
        INSERT INTO objects (bucket_id, key, original_name, size, etag, content_type)
        VALUES (${bucketId}, ${o.key}, ${o.name}, ${o.size}, ${etag}, ${o.contentType}) RETURNING id`;
      const objectId = objRow!.id;
      totalBytes += o.size;
      objectCount++;

      // media_assets
      const kindEnum = o.kind === "pdf" ? "pdf" : o.kind;
      await sql`
        INSERT INTO media_assets (object_id, kind, width, height, duration_ms, has_audio)
        VALUES (${objectId}, ${kindEnum}, ${o.width ?? null}, ${o.height ?? null}, ${o.durationMs ?? null}, ${o.kind === "video" || o.kind === "audio"})`;

      // thumbnail derivative (image → thumbnail; video → poster)
      await putObject(DERIVED_BUCKET, thumbKey, thumb, "image/png");
      await sql`
        INSERT INTO derivatives (object_id, type, minio_key, width, height, bytes, billable)
        VALUES (${objectId}, ${o.kind === "video" ? "poster" : "thumbnail"}, ${thumbKey}, 320, 240, ${thumb.length}, false)`;

      // tags
      for (const t of o.tags) {
        const tid = await tagId(t);
        await sql`INSERT INTO object_tags (object_id, tag_id) VALUES (${objectId}, ${tid}) ON CONFLICT DO NOTHING`;
      }
      // category
      if (o.category) {
        const cid = await categoryId(o.category);
        await sql`INSERT INTO object_categories (object_id, category_id) VALUES (${objectId}, ${cid}) ON CONFLICT DO NOTHING`;
      }

      // search index (filename + tags)
      const searchText = `${o.name} ${o.tags.join(" ")} ${o.category ?? ""}`;
      await sql`
        INSERT INTO search_index (object_id, tsv) VALUES (${objectId}, to_tsvector('english', ${searchText}))
        ON CONFLICT (object_id) DO UPDATE SET tsv = EXCLUDED.tsv`;

      if (o.kind === "image") imageObjectIds.push(objectId);
      if (o.kind === "video") videoObjectIds.push(objectId);
    }
  }

  // 7) Capacity (used = sum of object sizes; allocated = plan included 1000 GB).
  await sql`
    INSERT INTO capacity (org_id, allocated_bytes, used_bytes, auto_enabled, increment_gb, threshold_pct)
    VALUES (${orgId}, ${1000 * 1024 * 1024 * 1024}, ${totalBytes}, true, 10, 80)`;

  // 8) Sets (variant collections) — base image + sized variants.
  if (imageObjectIds.length >= 4) {
    const [heroSet] = await sql<{ id: string }[]>`
      INSERT INTO sets (org_id, name, base_object_id) VALUES (${orgId}, ${"Hero Banner Variants"}, ${imageObjectIds[0]}) RETURNING id`;
    const variants = [
      { id: imageObjectIds[0], role: "original", ar: "16:9", w: 1920, h: 1080 },
      { id: imageObjectIds[1], role: "mobile", ar: "9:16", w: 1080, h: 1920 },
      { id: imageObjectIds[2], role: "square", ar: "1:1", w: 1080, h: 1080 },
      { id: imageObjectIds[3], role: "thumb", ar: "4:3", w: 640, h: 480 },
    ];
    for (const v of variants) {
      await sql`INSERT INTO set_items (set_id, object_id, aspect_ratio, width, height, role)
        VALUES (${heroSet!.id}, ${v.id}, ${v.ar}, ${v.w}, ${v.h}, ${v.role}) ON CONFLICT DO NOTHING`;
    }
    const [logoSet] = await sql<{ id: string }[]>`
      INSERT INTO sets (org_id, name, base_object_id) VALUES (${orgId}, ${"Logo Pack"}, ${imageObjectIds[4] ?? imageObjectIds[0]}) RETURNING id`;
    for (const v of imageObjectIds.slice(4, 7)) {
      await sql`INSERT INTO set_items (set_id, object_id, role) VALUES (${logoSet!.id}, ${v}, ${"format"}) ON CONFLICT DO NOTHING`;
    }
  }

  // 9) Storyboards (clip sequences).
  const clips = [...videoObjectIds, ...imageObjectIds].slice(0, 5);
  if (clips.length) {
    const [sb] = await sql<{ id: string }[]>`
      INSERT INTO storyboards (org_id, name) VALUES (${orgId}, ${"Launch Promo"}) RETURNING id`;
    let pos = 0;
    for (const c of clips) {
      await sql`INSERT INTO storyboard_clips (storyboard_id, object_id, position, note)
        VALUES (${sb!.id}, ${c}, ${pos}, ${`Scene ${pos + 1}`}) ON CONFLICT DO NOTHING`;
      pos++;
    }
    await sql`INSERT INTO storyboards (org_id, name) VALUES (${orgId}, ${"Product Demo"})`;
  }

  // 10) Usage history — 30 daily rollups + recent events.
  for (let d = 29; d >= 0; d--) {
    const day = new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
    const stored = Math.round(totalBytes * (0.6 + (29 - d) / 75));
    const egress = mb(200 + Math.round(Math.sin(d) * 120 + d * 40));
    const requests = 400 + (29 - d) * 25 + (d % 7) * 60;
    await sql`
      INSERT INTO usage_rollups (org_id, period, stored_bytes_max, egress_bytes, request_count)
      VALUES (${orgId}, ${day}, ${stored}, ${egress}, ${requests})
      ON CONFLICT (org_id, period) DO UPDATE SET stored_bytes_max = EXCLUDED.stored_bytes_max, egress_bytes = EXCLUDED.egress_bytes, request_count = EXCLUDED.request_count`;
  }
  for (let h = 0; h < 12; h++) {
    await sql`INSERT INTO usage_events (org_id, type, bytes, ts)
      VALUES (${orgId}, 'egress', ${mb(10 + h * 3)}, ${new Date(Date.now() - h * 36e5).toISOString()})`;
  }

  // 11) API key (read+write) — print the secret once for tests/manual use.
  const key = await createApiKey(orgId, ["read", "write"], undefined, 365, "Local Dev Key");

  console.log("\n✓ Seed complete");
  console.log(`  org:        Test Studio (${orgId})`);
  console.log(`  login:      ${TEST_EMAIL} / ${TEST_PASSWORD}`);
  console.log(`  buckets:    ${buckets.length}  objects: ${objectCount}  (~${(totalBytes / 1024 / 1024 / 1024).toFixed(1)} GB used)`);
  console.log(`  API key:    ${key.accessKeyId}`);
  console.log(`  API secret: ${key.secret}   (bearer token — shown once)`);
}

main()
  .then(() => sql.end({ timeout: 5 }))
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("Seed failed:", err);
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  });
