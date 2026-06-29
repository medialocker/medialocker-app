// Use the shared @medialocker/db client instead of a separate hand-rolled pool
// (§P1). This keeps a single source of truth for connection config across the
// services.
import { createClient, disconnect, type Sql } from '@medialocker/db';

export function getDb(): Sql {
  return createClient();
}

export async function closeDb(): Promise<void> {
  await disconnect();
}

export type { Sql };
