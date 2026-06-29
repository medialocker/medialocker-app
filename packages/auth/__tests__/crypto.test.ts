import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "../src/index.js";

describe("encrypt / decrypt (AES-256-GCM)", () => {
  const samples = [
    "hello world",
    "",
    "a",
    "unicode: café ☕ 日本語 🔒",
    "x".repeat(1024),
    JSON.stringify({ nested: { value: 42, arr: [1, 2, 3] } }),
  ];

  it("round-trips every sample exactly", () => {
    for (const plaintext of samples) {
      expect(decrypt(encrypt(plaintext))).toBe(plaintext);
    }
  });

  it("produces ciphertext that differs from the plaintext", () => {
    const plaintext = "super-secret-value";
    const encoded = encrypt(plaintext);
    expect(encoded).not.toBe(plaintext);
    expect(encoded).not.toContain(plaintext);
  });

  it("uses a random IV so two encryptions of the same value differ", () => {
    const plaintext = "same-input";
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(a).not.toBe(b);
    // Both still decrypt back to the original.
    expect(decrypt(a)).toBe(plaintext);
    expect(decrypt(b)).toBe(plaintext);
  });

  it("throws when the ciphertext body is tampered with (GCM auth tag)", () => {
    const encoded = encrypt("tamper-me");
    const buf = Buffer.from(encoded, "base64");
    // Flip a bit in the ciphertext body (after 12-byte IV + 16-byte tag).
    const bodyIndex = buf.length - 1;
    buf[bodyIndex] = buf[bodyIndex]! ^ 0x01;
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("throws when the auth tag is tampered with", () => {
    const encoded = encrypt("tamper-tag");
    const buf = Buffer.from(encoded, "base64");
    // Flip a bit inside the 16-byte auth tag (bytes 12..28).
    buf[12] = buf[12]! ^ 0x01;
    expect(() => decrypt(buf.toString("base64"))).toThrow();
  });

  it("throws when the IV is tampered with", () => {
    const encoded = encrypt("tamper-iv");
    const buf = Buffer.from(encoded, "base64");
    buf[0] = buf[0]! ^ 0x01;
    expect(() => decrypt(buf.toString("base64"))).toThrow();
  });
});
