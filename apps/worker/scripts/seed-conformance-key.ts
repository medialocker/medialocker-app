/**
 * Mint a throwaway org + API key for MCP contract conformance testing.
 *
 * The MCP `/mcp` transport is Bearer-gated (the auth hook resolves a tenant from
 * the API key via @medialocker/auth). The conformance kit
 * (@reaatech/mcp-contract-cli) authenticates with `--bearer <token>`, so CI needs
 * a real key. This script creates a minimal organization and a full-scope key,
 * then prints ONLY the plaintext secret to stdout so the workflow can capture it:
 *
 *   MCP_BEARER=$(pnpm --filter @medialocker/worker exec tsx scripts/seed-conformance-key.ts)
 *
 * It relies on the same DATABASE_URL + API_KEY_ENC_KEY the MCP server runs with,
 * so the server can decrypt and verify the token. Intended for ephemeral CI/local
 * databases only — never run against production data.
 */
import { randomUUID } from 'node:crypto';
import { createApiKey } from '@medialocker/auth';
import { createOrganization } from '@medialocker/db';

async function main(): Promise<void> {
  const slug = `conformance-${randomUUID().slice(0, 8)}`;
  const org = await createOrganization('MCP Conformance', slug);
  const orgId = org['id'] as string;
  const key = await createApiKey(orgId, ['read', 'write', 'delete', 'admin'], undefined, 1, 'mcp-conformance');
  // stdout = the bearer secret only; diagnostics go to stderr.
  process.stderr.write(`seeded org ${orgId} (${slug}) + key ${key.accessKeyId}\n`);
  process.stdout.write(key.secret);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`seed-conformance-key failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
