import { describe, it, expect, vi } from "vitest";

vi.mock("@medialocker/config", () => ({
  getConfig: () => ({
    INTERNAL_API_SECRET: "test-secret-123",
    // Needed because the middleware module imports @medialocker/observability,
    // whose logger reads these from config at first use.
    LOG_LEVEL: "silent",
    NODE_ENV: "test",
  }),
}));

import { signInternalRequest } from "@medialocker/auth";
import { verifyInternalAuth } from "../middleware/auth.js";

const SECRET = "test-secret-123";

describe("internal HMAC auth round trip", () => {
  it("verifies a header produced by signInternalRequest", () => {
    const method = "POST";
    const path = "/api/presign/download";
    const header = signInternalRequest(method, path, SECRET);
    expect(verifyInternalAuth(header, method, path)).toBe(true);
  });

  it("verifies with a lowercase method (signer uppercases canonical)", () => {
    const path = "/api/presign/download";
    const header = signInternalRequest("get", path, SECRET);
    // verify side passes request.method which is already uppercase
    expect(verifyInternalAuth(header, "GET", path)).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const method = "POST";
    const path = "/api/presign/download";
    const header = signInternalRequest(method, path, SECRET);
    // Flip the last hex char of the signature.
    const last = header.endsWith("0") ? "1" : "0";
    const tampered = header.slice(0, -1) + last;
    expect(verifyInternalAuth(tampered, method, path)).toBe(false);
  });

  it("rejects a signature signed with a different secret", () => {
    const method = "POST";
    const path = "/api/presign/download";
    const header = signInternalRequest(method, path, "wrong-secret");
    expect(verifyInternalAuth(header, method, path)).toBe(false);
  });

  it("rejects an expired timestamp (>60s old)", () => {
    const method = "GET";
    const path = "/api/objects/123";
    const oldTs = Math.floor(Date.now() / 1000) - 61;
    const header = signInternalRequest(method, path, SECRET, oldTs);
    expect(verifyInternalAuth(header, method, path)).toBe(false);
  });

  it("rejects a future timestamp (>60s ahead)", () => {
    const method = "GET";
    const path = "/api/objects/123";
    const futureTs = Math.floor(Date.now() / 1000) + 61;
    const header = signInternalRequest(method, path, SECRET, futureTs);
    expect(verifyInternalAuth(header, method, path)).toBe(false);
  });

  it("rejects a different method than was signed", () => {
    const path = "/api/presign/download";
    const header = signInternalRequest("POST", path, SECRET);
    expect(verifyInternalAuth(header, "GET", path)).toBe(false);
  });

  it("rejects a different path than was signed", () => {
    const method = "GET";
    const header = signInternalRequest(method, "/api/objects/123", SECRET);
    expect(verifyInternalAuth(header, method, "/api/objects/456")).toBe(false);
  });

  it("rejects a malformed header without a colon separator", () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyInternalAuth(`Internal ${ts}`, "GET", "/api/x")).toBe(false);
  });

  it("rejects a non-Internal header", () => {
    expect(verifyInternalAuth("Bearer abc", "GET", "/api/x")).toBe(false);
  });
});
