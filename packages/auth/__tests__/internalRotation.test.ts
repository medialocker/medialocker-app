import { describe, it, expect } from "vitest";
import {
  signInternalRequest,
  encrypt,
  resolveInternalSecretCandidates,
  verifyInternalRequestWithSecrets,
  verifyInternalRequest,
} from "../src/index.js";

/**
 * §5 secret-rotation loop: the internal-HMAC verifier must accept a signature
 * valid under EITHER the current OR the immediately-previous INTERNAL_API_SECRET
 * (grace window), reading from the durable `service_secrets` store with the
 * env/config value as fallback/bootstrap. The SIGNER keeps using the current
 * secret. These tests exercise that grace-window behaviour without a DB by
 * injecting a `fetchVersions` stub (the real call site passes
 * @medialocker/db#getServiceSecretVersions).
 */

const METHOD = "POST";
const PATH = "/api/internal/objects";
const CURRENT = "current-internal-secret";
const PREVIOUS = "previous-internal-secret";
const ENV_FALLBACK = "env-bootstrap-secret";

// Mimics getServiceSecretVersions: current-first, then previous, AES-GCM enc.
function storeWith(values: { value: string; stage: "current" | "previous" }[]) {
  return async () =>
    values.map((v) => ({ value_enc: encrypt(v.value), stages: [v.stage] }));
}

describe("resolveInternalSecretCandidates", () => {
  it("returns [current, previous] from the store plus the env fallback", async () => {
    const candidates = await resolveInternalSecretCandidates(
      ENV_FALLBACK,
      storeWith([
        { value: CURRENT, stage: "current" },
        { value: PREVIOUS, stage: "previous" },
      ]),
    );
    expect(candidates).toEqual([CURRENT, PREVIOUS, ENV_FALLBACK]);
  });

  it("falls back to env-only when the store is empty (never rotated)", async () => {
    const candidates = await resolveInternalSecretCandidates(
      ENV_FALLBACK,
      async () => [],
    );
    expect(candidates).toEqual([ENV_FALLBACK]);
  });

  it("falls back to env-only when the store throws", async () => {
    const candidates = await resolveInternalSecretCandidates(ENV_FALLBACK, async () => {
      throw new Error("db down");
    });
    expect(candidates).toEqual([ENV_FALLBACK]);
  });

  it("does not duplicate the fallback when it already equals current", async () => {
    const candidates = await resolveInternalSecretCandidates(
      CURRENT,
      storeWith([{ value: CURRENT, stage: "current" }]),
    );
    expect(candidates).toEqual([CURRENT]);
  });
});

describe("verifyInternalRequest (grace window)", () => {
  const fetch = storeWith([
    { value: CURRENT, stage: "current" },
    { value: PREVIOUS, stage: "previous" },
  ]);

  it("accepts a signature made with the CURRENT secret", async () => {
    const header = signInternalRequest(METHOD, PATH, CURRENT);
    expect(await verifyInternalRequest(header, METHOD, PATH, ENV_FALLBACK, fetch)).toBe(
      true,
    );
  });

  it("accepts a signature made with the PREVIOUS secret (in-flight rotation)", async () => {
    const header = signInternalRequest(METHOD, PATH, PREVIOUS);
    expect(await verifyInternalRequest(header, METHOD, PATH, ENV_FALLBACK, fetch)).toBe(
      true,
    );
  });

  it("rejects a signature made with an unrelated secret", async () => {
    const header = signInternalRequest(METHOD, PATH, "attacker-secret");
    expect(await verifyInternalRequest(header, METHOD, PATH, ENV_FALLBACK, fetch)).toBe(
      false,
    );
  });

  it("accepts the env fallback before any rotation (empty store)", async () => {
    const header = signInternalRequest(METHOD, PATH, ENV_FALLBACK);
    expect(
      await verifyInternalRequest(header, METHOD, PATH, ENV_FALLBACK, async () => []),
    ).toBe(true);
  });

  it("rejects a stale timestamp outside the ±60s window", async () => {
    const old = Math.floor(Date.now() / 1000) - 120;
    const header = signInternalRequest(METHOD, PATH, CURRENT, old);
    expect(await verifyInternalRequest(header, METHOD, PATH, ENV_FALLBACK, fetch)).toBe(
      false,
    );
  });

  it("rejects when method or path differ from what was signed", async () => {
    const header = signInternalRequest(METHOD, PATH, CURRENT);
    expect(
      verifyInternalRequestWithSecrets(header, "GET", PATH, [CURRENT]),
    ).toBe(false);
    expect(
      verifyInternalRequestWithSecrets(header, METHOD, "/api/other", [CURRENT]),
    ).toBe(false);
  });

  it("rejects malformed headers", () => {
    expect(verifyInternalRequestWithSecrets("Bearer x", METHOD, PATH, [CURRENT])).toBe(
      false,
    );
    expect(
      verifyInternalRequestWithSecrets("Internal nocolon", METHOD, PATH, [CURRENT]),
    ).toBe(false);
  });
});
