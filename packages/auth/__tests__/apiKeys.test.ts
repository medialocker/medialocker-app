import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB seam: the auth module imports these named functions from
// @medialocker/db. We replace them with spies so no real database is touched.
// The factory must be self-contained because vi.mock is hoisted above imports.
vi.mock("@medialocker/db", () => ({
  insertApiKey: vi.fn(),
  getApiKeyByAccessKeyId: vi.fn(),
  getApiKeyByBearerHash: vi.fn(),
  revokeApiKey: vi.fn(),
  updateApiKeyLastUsed: vi.fn(),
  getMembershipsForUser: vi.fn(),
}));

import * as db from "@medialocker/db";
import {
  createApiKey,
  verifySigV4Key,
  verifyBearerToken,
  revokeApiKey,
  resolveOrgFromUser,
  encrypt,
  decrypt,
} from "../src/index.js";

import crypto from "node:crypto";

// Typed handles to the mocked DB functions.
const dbMocks = {
  insertApiKey: vi.mocked(db.insertApiKey),
  getApiKeyByAccessKeyId: vi.mocked(db.getApiKeyByAccessKeyId),
  getApiKeyByBearerHash: vi.mocked(db.getApiKeyByBearerHash),
  revokeApiKey: vi.mocked(db.revokeApiKey),
  updateApiKeyLastUsed: vi.mocked(db.updateApiKeyLastUsed),
  getMembershipsForUser: vi.mocked(db.getMembershipsForUser),
};

type Row = Record<string, unknown>;

// getMembershipsForUser returns postgres' branded RowList type, not a plain
// array; cast fixtures to that awaited return type to stay type-clean.
type MembershipRows = Awaited<ReturnType<typeof db.getMembershipsForUser>>;

/** Build a stored api_keys row whose secret_enc encrypts the given secret. */
function makeKeyRow(secret: string, overrides: Partial<Row> = {}): Row {
  return {
    id: "key-id-1",
    org_id: "org-1",
    access_key_id: "AKIDtest",
    secret_enc: encrypt(secret),
    bearer_lookup_hash: crypto
      .createHash("sha256")
      .update(secret)
      .digest("base64"),
    scopes: ["read", "write"],
    bucket_scope: "bucket-a",
    expires_at: new Date(Date.now() + 1000).toISOString(),
    revoked_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.updateApiKeyLastUsed.mockResolvedValue(undefined);
});

describe("createApiKey", () => {
  it("inserts an encrypted secret (never plaintext) and returns the one-time secret", async () => {
    let inserted: Row | undefined;
    dbMocks.insertApiKey.mockImplementation(async (data: Row) => {
      inserted = data;
      return { id: "generated-key-id", access_key_id: data["access_key_id"] };
    });

    const result = await createApiKey("org-42", ["s3:read"], "my-bucket");

    expect(dbMocks.insertApiKey).toHaveBeenCalledTimes(1);
    expect(inserted).toBeDefined();
    const row = inserted!;

    // Org + scopes + bucket scope are passed through.
    expect(row["org_id"]).toBe("org-42");
    expect(row["scopes"]).toEqual(["s3:read"]);
    expect(row["bucket_scope"]).toBe("my-bucket");

    // An access key id was generated with the expected prefix.
    expect(row["access_key_id"]).toMatch(/^ml_[0-9a-f]{32}$/);

    // The stored secret is encrypted, not plaintext, and decrypts back.
    expect(row["secret_enc"]).not.toBe(result.secret);
    expect(decrypt(row["secret_enc"] as string)).toBe(result.secret);

    // A bearer lookup hash matching sha256(secret) is stored.
    const expectedHash = crypto
      .createHash("sha256")
      .update(result.secret)
      .digest("hex");
    expect(row["bearer_lookup_hash"]).toBe(expectedHash);

    // The returned secret is the one-time plaintext.
    expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.keyId).toBe("generated-key-id");
    expect(result.accessKeyId).toBe(row["access_key_id"]);
  });

  it("applies the default 90-day expiry", async () => {
    let inserted: Row | undefined;
    dbMocks.insertApiKey.mockImplementation(async (data: Row) => {
      inserted = data;
      return { id: "k", access_key_id: data["access_key_id"] };
    });

    const before = Date.now();
    await createApiKey("org-1", ["read"]);
    const after = Date.now();

    const expiresAt = new Date(inserted!["expires_at"] as string).getTime();
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(before + ninetyDays - 5000);
    expect(expiresAt).toBeLessThanOrEqual(after + ninetyDays + 5000);
  });

  it("honors a custom expiry and a null bucket scope", async () => {
    let inserted: Row | undefined;
    dbMocks.insertApiKey.mockImplementation(async (data: Row) => {
      inserted = data;
      return { id: "k", access_key_id: data["access_key_id"] };
    });

    const before = Date.now();
    await createApiKey("org-1", ["read"], undefined, 1);
    const after = Date.now();

    expect(inserted!["bucket_scope"]).toBeNull();
    const expiresAt = new Date(inserted!["expires_at"] as string).getTime();
    const oneDay = 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(before + oneDay - 5000);
    expect(expiresAt).toBeLessThanOrEqual(after + oneDay + 5000);
  });

  it("generates a distinct secret and access key id per call", async () => {
    dbMocks.insertApiKey.mockImplementation(async (data: Row) => ({
      id: "k",
      access_key_id: data["access_key_id"],
    }));
    const a = await createApiKey("org-1", ["read"]);
    const b = await createApiKey("org-1", ["read"]);
    expect(a.secret).not.toBe(b.secret);
    expect(a.accessKeyId).not.toBe(b.accessKeyId);
  });
});

describe("verifySigV4Key", () => {
  it("returns the decrypted secret and metadata for a valid key", async () => {
    const secret = "the-real-secret";
    dbMocks.getApiKeyByAccessKeyId.mockResolvedValue(makeKeyRow(secret));

    const verified = await verifySigV4Key("AKIDtest");

    expect(verified).not.toBeNull();
    expect(verified!.secret).toBe(secret);
    expect(verified!.orgId).toBe("org-1");
    expect(verified!.scopes).toEqual(["read", "write"]);
    expect(verified!.bucketScope).toBe("bucket-a");
    // last_used_at should be touched for a successful verification.
    expect(dbMocks.updateApiKeyLastUsed).toHaveBeenCalledWith("key-id-1");
  });

  it("rejects an unknown access key id (DB returns null)", async () => {
    dbMocks.getApiKeyByAccessKeyId.mockResolvedValue(null);
    expect(await verifySigV4Key("AKIDmissing")).toBeNull();
    expect(dbMocks.updateApiKeyLastUsed).not.toHaveBeenCalled();
  });

  it("rejects revoked/expired keys (DB filters them out, returning null)", async () => {
    // getApiKeyByAccessKeyId only returns rows where revoked_at IS NULL AND
    // expires_at > now(); a revoked or expired key surfaces as null.
    dbMocks.getApiKeyByAccessKeyId.mockResolvedValue(null);
    expect(await verifySigV4Key("AKIDrevoked")).toBeNull();
  });

  it("returns null when the stored ciphertext cannot be decrypted", async () => {
    const row = makeKeyRow("secret");
    row["secret_enc"] = "not-valid-ciphertext";
    dbMocks.getApiKeyByAccessKeyId.mockResolvedValue(row);
    expect(await verifySigV4Key("AKIDtest")).toBeNull();
  });
});

describe("verifyBearerToken", () => {
  it("looks up by bearer hash and returns the key when the token matches", async () => {
    const secret = "bearer-secret-token";
    const row = makeKeyRow(secret);
    dbMocks.getApiKeyByBearerHash.mockResolvedValue(row);

    const verified = await verifyBearerToken(secret);

    expect(verified).not.toBeNull();
    expect(verified!.secret).toBe(secret);
    expect(verified!.orgId).toBe("org-1");

    // Lookup is performed by sha256(token) hex hash.
    const expectedHash = crypto
      .createHash("sha256")
      .update(secret)
      .digest("hex");
    expect(dbMocks.getApiKeyByBearerHash).toHaveBeenCalledWith(expectedHash);
    expect(dbMocks.updateApiKeyLastUsed).toHaveBeenCalledWith("key-id-1");
  });

  it("rejects when no row matches the bearer hash (unknown/revoked/expired)", async () => {
    dbMocks.getApiKeyByBearerHash.mockResolvedValue(null);
    expect(await verifyBearerToken("nope")).toBeNull();
    expect(dbMocks.updateApiKeyLastUsed).not.toHaveBeenCalled();
  });

  it("rejects when the decrypted secret does not match the presented token", async () => {
    // Hash collision-ish scenario: a row is found but the stored secret
    // differs from the presented token -> constant-time compare fails.
    const row = makeKeyRow("the-actual-secret");
    dbMocks.getApiKeyByBearerHash.mockResolvedValue(row);
    expect(await verifyBearerToken("a-different-token")).toBeNull();
    expect(dbMocks.updateApiKeyLastUsed).not.toHaveBeenCalled();
  });

  it("returns null when stored ciphertext cannot be decrypted", async () => {
    const row = makeKeyRow("secret");
    row["secret_enc"] = "garbage";
    dbMocks.getApiKeyByBearerHash.mockResolvedValue(row);
    expect(await verifyBearerToken("secret")).toBeNull();
  });
});

describe("revokeApiKey", () => {
  it("delegates to the DB revoke (UPDATE scoped by key id)", async () => {
    dbMocks.revokeApiKey.mockResolvedValue(undefined);
    await revokeApiKey("key-id-99");
    expect(dbMocks.revokeApiKey).toHaveBeenCalledTimes(1);
    expect(dbMocks.revokeApiKey).toHaveBeenCalledWith("key-id-99");
  });
});

describe("resolveOrgFromUser (P2: deterministic selection)", () => {
  it("prefers the highest role regardless of DB row order", async () => {
    // member listed first, owner second — must still pick the owner org.
    dbMocks.getMembershipsForUser.mockResolvedValue([
      { org_id: "org-8", role: "member", created_at: "2020-01-01T00:00:00Z" },
      { org_id: "org-7", role: "owner", created_at: "2024-01-01T00:00:00Z" },
    ] as unknown as MembershipRows);
    const resolved = await resolveOrgFromUser("user-1");
    expect(resolved).toEqual({ orgId: "org-7", role: "owner" });
    expect(dbMocks.getMembershipsForUser).toHaveBeenCalledWith("user-1");
  });

  it("orders owner > admin > member", async () => {
    dbMocks.getMembershipsForUser.mockResolvedValue([
      { org_id: "org-a", role: "admin", created_at: "2021-01-01T00:00:00Z" },
      { org_id: "org-m", role: "member", created_at: "2020-01-01T00:00:00Z" },
      { org_id: "org-o", role: "owner", created_at: "2023-01-01T00:00:00Z" },
    ] as unknown as MembershipRows);
    expect(await resolveOrgFromUser("user-1")).toEqual({
      orgId: "org-o",
      role: "owner",
    });
  });

  it("tie-breaks equal roles by OLDEST membership (created_at asc)", async () => {
    dbMocks.getMembershipsForUser.mockResolvedValue([
      { org_id: "org-new", role: "admin", created_at: "2024-06-01T00:00:00Z" },
      { org_id: "org-old", role: "admin", created_at: "2022-06-01T00:00:00Z" },
    ] as unknown as MembershipRows);
    expect(await resolveOrgFromUser("user-1")).toEqual({
      orgId: "org-old",
      role: "admin",
    });
  });

  it("is stable (org_id tie-break) when role and created_at are equal", async () => {
    const rows = [
      { org_id: "org-z", role: "member", created_at: "2022-01-01T00:00:00Z" },
      { org_id: "org-a", role: "member", created_at: "2022-01-01T00:00:00Z" },
    ];
    dbMocks.getMembershipsForUser.mockResolvedValue(
      rows as unknown as MembershipRows,
    );
    const first = await resolveOrgFromUser("user-1");
    // Same input reversed must yield the same winner (determinism).
    dbMocks.getMembershipsForUser.mockResolvedValue(
      [...rows].reverse() as unknown as MembershipRows,
    );
    const second = await resolveOrgFromUser("user-1");
    expect(first).toEqual({ orgId: "org-a", role: "member" });
    expect(second).toEqual(first);
  });

  it("returns null when the user has no memberships", async () => {
    dbMocks.getMembershipsForUser.mockResolvedValue([] as unknown as MembershipRows);
    expect(await resolveOrgFromUser("user-1")).toBeNull();
  });
});
