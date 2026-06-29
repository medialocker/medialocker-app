import { defineConfig } from "vitest/config";

// A deterministic, valid 32-byte (base64) key for AES-256-GCM used only in tests.
const TEST_ENC_KEY = Buffer.alloc(32, 7).toString("base64");

export default defineConfig({
  test: {
    passWithNoTests: true,
    env: {
      NODE_ENV: "test",
      API_KEY_ENC_KEY: TEST_ENC_KEY,
      // Asymmetric JWT verification needs the project URL for the JWKS endpoint
      // + issuer pinning. The JWKS fetch itself is stubbed in jwt.test.ts.
      SUPABASE_URL: "https://test-ref.supabase.co",
    },
  },
});
