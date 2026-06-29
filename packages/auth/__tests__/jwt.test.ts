import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import { generateKeyPairSync } from "node:crypto";
import { verifySupabaseJwt, decodeSupabaseJwt, resetJwksCache } from "../src/index.js";

// Must match SUPABASE_URL in vitest.config.ts.
const SUPABASE_URL = "https://test-ref.supabase.co";
const ISS = `${SUPABASE_URL}/auth/v1`;
const JWKS_URL = `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`;

/** Generate an EC P-256 keypair; return the public JWK (for the JWKS) + private PEM (to sign). */
function makeKeypair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = {
    ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>),
    kid,
    use: "sig",
    alg: "ES256",
  };
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  return { jwk, privatePem };
}

function sign(
  privatePem: string,
  opts: {
    kid?: string;
    issuer?: string;
    audience?: string;
    expiresIn?: string | number;
    algorithm?: jwt.Algorithm;
    payload?: Record<string, unknown>;
  } = {},
): string {
  const {
    kid,
    issuer = ISS,
    audience = "authenticated",
    expiresIn = "1h",
    algorithm = "ES256",
    payload = {},
  } = opts;
  return jwt.sign({ sub: "user-123", email: "user@example.com", ...payload }, privatePem, {
    algorithm,
    ...(kid ? { keyid: kid } : {}),
    issuer,
    audience,
    expiresIn,
  });
}

/** Stub global fetch to serve the given JWKS at the project's JWKS endpoint. */
function stubJwks(keys: object[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === JWKS_URL) {
        return { ok: true, json: async () => ({ keys }) } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    }),
  );
}

const KID = "test-kid-1";

describe("verifySupabaseJwt (asymmetric / JWKS)", () => {
  let kp: ReturnType<typeof makeKeypair>;

  beforeEach(() => {
    resetJwksCache();
    kp = makeKeypair(KID);
    stubJwks([kp.jwk]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("verifies a correctly-signed ES256 token via JWKS", async () => {
    const token = sign(kp.privatePem, { kid: KID, payload: { org_id: "org-9" } });
    const payload = await verifySupabaseJwt(token);
    expect(payload.sub).toBe("user-123");
    expect(payload.email).toBe("user@example.com");
    expect(payload.aud).toBe("authenticated");
    expect(payload.org_id).toBe("org-9");
    expect(typeof payload.exp).toBe("number");
  });

  it("rejects a token signed by a different key (signature mismatch)", async () => {
    // Same kid, different private key — the JWKS still serves the original public key.
    const impostor = makeKeypair(KID);
    const token = sign(impostor.privatePem, { kid: KID });
    await expect(verifySupabaseJwt(token)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const token = sign(kp.privatePem, { kid: KID, expiresIn: -10 });
    await expect(verifySupabaseJwt(token)).rejects.toThrow();
  });

  it("rejects a token with the wrong audience", async () => {
    const token = sign(kp.privatePem, { kid: KID, audience: "anon" });
    await expect(verifySupabaseJwt(token)).rejects.toThrow();
  });

  it("rejects a token with the wrong issuer (cross-project replay)", async () => {
    const token = sign(kp.privatePem, { kid: KID, issuer: "https://evil.supabase.co/auth/v1" });
    await expect(verifySupabaseJwt(token)).rejects.toThrow();
  });

  it("rejects a token missing the kid header", async () => {
    const token = sign(kp.privatePem, {}); // no keyid
    await expect(verifySupabaseJwt(token)).rejects.toThrow(/kid/i);
  });

  it("rejects a legacy HS256 token (asymmetric-only)", async () => {
    const token = jwt.sign({ sub: "user-123" }, "shared-secret", {
      algorithm: "HS256",
      keyid: KID,
      issuer: ISS,
      audience: "authenticated",
      expiresIn: "1h",
    });
    await expect(verifySupabaseJwt(token)).rejects.toThrow(/algorithm/i);
  });

  it("rejects when the kid is not present in the JWKS", async () => {
    const token = sign(kp.privatePem, { kid: "unknown-kid" });
    await expect(verifySupabaseJwt(token)).rejects.toThrow(/JWKS|kid/i);
  });

  it("rejects structurally invalid garbage", async () => {
    await expect(verifySupabaseJwt("not-a-jwt")).rejects.toThrow();
  });
});

describe("decodeSupabaseJwt", () => {
  it("decodes the payload without verifying the signature", () => {
    const kp = makeKeypair("kid-x");
    const token = sign(kp.privatePem, { kid: "kid-x", payload: { org_id: "org-9" } });
    const decoded = decodeSupabaseJwt(token);
    expect(decoded).not.toBeNull();
    expect(decoded!.sub).toBe("user-123");
    expect(decoded!.org_id).toBe("org-9");
  });

  it("returns null for non-JWT garbage", () => {
    expect(decodeSupabaseJwt("garbage")).toBeNull();
    expect(decodeSupabaseJwt("")).toBeNull();
  });
});
