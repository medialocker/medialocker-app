import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  PUBLIC_BASE_DOMAIN: z.string().default("medialocker.io"),
  S3_PUBLIC_ENDPOINT: z.string().default("https://s3.medialocker.io"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

  // Comma-separated CIDR ranges to trust for X-Forwarded-For (e.g., "10.0.0.0/8,172.16.0.0/12").
  // In production this MUST include the Docker network where Caddy/the reverse proxy runs.
  // Without it, request.ip becomes the proxy's IP for every client, breaking rate limits
  // and audit logs.
  TRUSTED_PROXY_CIDRS: z.string().optional(),

  // Postgres connection. The default is the local dev/CI Postgres; production runs
  // on Supabase Cloud — point this at the TRANSACTION pooler (port 6543) for the
  // app runtime, with `?sslmode=require`. The migration runner needs the SESSION
  // pooler (5432) or a direct connection (see packages/db/scripts/migrate.ts).
  DATABASE_URL: z.string().default("postgresql://medialocker_service:password@localhost:5432/medialocker"),
  // Supabase Cloud — managed Postgres (DATABASE_URL above) + Auth. SUPABASE_URL is
  // the project URL (https://<ref>.supabase.co). Dashboard session JWTs are signed
  // with asymmetric keys (ES256) and verified against the project JWKS endpoint
  // (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`, see
  // @medialocker/auth#verifySupabaseJwt) — no shared HS256 secret. SUPABASE_URL is
  // required in production (guarded below); optional in dev/CI/test.
  // SUPABASE_SECRET_KEY (sb_secret_…) is backend/admin-tooling only (e.g. the dev
  // seed's Admin API calls); never exposed to the browser.
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SECRET_KEY: z.string().optional(),

  REDIS_URL: z.string().default("redis://localhost:6379"),

  // Per-org S3 request rate limit (req/s/org, §17). Read via getConfig() rather
  // than process.env so the limiter is validated/typed like all other config.
  S3_RATE_LIMIT_PER_SEC: z.coerce.number().int().positive().default(1000),

  // Hetzner Object Storage — one project, one master credential held only by the
  // backend (api/worker/mcp). Tenants never see these; they get short-lived
  // presigned URLs (§7.1). The clients sign PATH-STYLE URLs
  // (`<endpoint>/<bucket>/<key>`) — the dev/CI default points at MinIO (which
  // requires path-style) and Hetzner accepts path-style too, so one setting works
  // in both. The virtual-host form `<bucket>.<region>.your-objectstorage.com`
  // is a post-spike optimization, gated on the live-Hetzner §3 validation.
  HETZNER_S3_ENDPOINT: z.string().default("http://minio:9000"),
  HETZNER_S3_REGION: z.string().default("us-east-1"),
  HETZNER_S3_ACCESS_KEY: z.string().default("minioadmin"),
  HETZNER_S3_SECRET_KEY: z.string().default("minioadmin"),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PORTAL_CONFIG_ID: z.string().optional(),

  // Transactional email (Resend). Held only by the backend (api/worker). When
  // RESEND_API_KEY is unset, @medialocker/email is a logged no-op — the same
  // graceful-degradation shape as STRIPE_SECRET_KEY above, so dev/CI/test boot
  // and run without sending anything. EMAIL_FROM must use a domain verified in
  // Resend (or the resend.dev sandbox address) or sends are rejected.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("MediaLocker <no-reply@medialocker.io>"),
  CONTACT_INBOX: z.string().default("support@medialocker.io"),
  EMAIL_LOGO_URL: z.string().default("https://medialocker.io/email-logo.png"),

  INTERNAL_API_SECRET: z.string().default("changeme-internal-secret"),
  API_KEY_ENC_KEY: z.string().default("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),

  CLOUDFLARE_API_TOKEN: z.string().optional(),

  PLAUSIBLE_DOMAIN: z.string().optional(),
  PLAUSIBLE_SECRET_KEY: z.string().optional(),
}).superRefine((cfg, ctx) => {
  // The AES-256-GCM key must decode to exactly 32 bytes in every environment —
  // a wrong length silently corrupts encrypt/decrypt of API-key secrets.
  let keyLen = 0;
  try {
    keyLen = Buffer.from(cfg.API_KEY_ENC_KEY, "base64").length;
  } catch {
    keyLen = -1;
  }
  if (keyLen !== 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["API_KEY_ENC_KEY"],
      message: `must be base64 for exactly 32 bytes (got ${keyLen} bytes)`,
    });
  }

  // Refuse the well-known placeholder API_KEY_ENC_KEY in non-test environments —
  // it's base64 of 32 zero bytes and trivially compromises all encrypted secrets
  // (API key bearer tokens, service_secrets). The test env uses dummy values.
  const PLACEHOLDER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  if (cfg.NODE_ENV !== "test" && cfg.API_KEY_ENC_KEY === PLACEHOLDER_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["API_KEY_ENC_KEY"],
      message: "must be set to a real secret (refusing the publicly known placeholder)",
    });
  }

  // In production, refuse to boot with the well-known placeholder secrets that
  // the defaults fall back to — they are publicly known and trivially exploited.
  if (cfg.NODE_ENV === "production") {
    const insecure: Array<[keyof typeof cfg, unknown, string]> = [
      ["INTERNAL_API_SECRET", cfg.INTERNAL_API_SECRET, "changeme-internal-secret"],
      ["API_KEY_ENC_KEY", cfg.API_KEY_ENC_KEY, PLACEHOLDER_KEY],
      ["HETZNER_S3_ACCESS_KEY", cfg.HETZNER_S3_ACCESS_KEY, "minioadmin"],
      ["HETZNER_S3_SECRET_KEY", cfg.HETZNER_S3_SECRET_KEY, "minioadmin"],
    ];
    for (const [name, value, bad] of insecure) {
      if (value === bad) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name as string],
          message: `must be set to a real secret in production (refusing the default placeholder)`,
        });
      }
    }
    if (cfg.DATABASE_URL.includes("medialocker_service:password@")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message: "must not use the default placeholder password in production",
      });
    }

    // Auth + DB run on Supabase Cloud; production must point at a real project,
    // not a localhost / self-hosted-kong default. SUPABASE_URL is all that's
    // needed to verify dashboard sessions — JWTs are checked against the project
    // JWKS (asymmetric ES256), so there is no shared secret to configure.
    if (
      !cfg.SUPABASE_URL ||
      cfg.SUPABASE_URL.includes("localhost") ||
      cfg.SUPABASE_URL.includes("supabase-kong")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SUPABASE_URL"],
        message:
          "must be set to the Supabase Cloud project URL (https://<ref>.supabase.co) in production",
      });
    }
  }
});

export type EnvConfig = z.infer<typeof envSchema>;

let _config: EnvConfig | null = null;

export function loadConfig(overrides?: Partial<EnvConfig>): EnvConfig {
  if (_config && !overrides) return _config;

  const raw: Record<string, string | undefined> = {};
  for (const [key, val] of Object.entries(process.env)) {
    raw[key] = val;
  }
  if (overrides) {
    for (const [key, val] of Object.entries(overrides)) {
      if (val !== undefined && val !== null) {
        raw[key] = String(val);
      }
    }
  }

  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${errors}`);
  }

  _config = result.data;
  return _config;
}

export function getConfig(): EnvConfig {
  if (!_config) return loadConfig();
  return _config;
}

export function resetConfig(): void {
  _config = null;
}

/**
 * Parse TRUSTED_PROXY_CIDRS into a value suitable for Fastify's `trustProxy`
 * option. Returns `true` in non-production (trust everything), `false` if the
 * var is empty, or a string/string[] of CIDRs.
 */
export function getTrustedProxyCidrs(): boolean | string | string[] {
  const cfg = getConfig();
  if (cfg.NODE_ENV !== "production") return true;
  const raw = cfg.TRUSTED_PROXY_CIDRS;
  if (!raw || raw.trim().length === 0) return false;
  const cidrs = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return cidrs.length === 1 ? cidrs[0]! : cidrs;
}

export { envSchema };
