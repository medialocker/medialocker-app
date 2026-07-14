import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['__tests__/**/*.test.ts'],
    // The first cold `await import(../src/webhook.js)` pulls the full Stripe/AWS/
    // OTEL graph and can exceed the default 5s timeout on CI cold starts — this
    // intermittently failed webhook.test.ts. Give tests generous headroom.
    testTimeout: 20000,
  },
});
