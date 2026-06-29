import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "./supabase-env";

/**
 * §2.6 — Browser Supabase client backed by **httpOnly cookies** (via
 * `@supabase/ssr`), not localStorage. `createBrowserClient` reads/writes the
 * session through `document.cookie`; the middleware (middleware.ts) mirrors and
 * refreshes those cookies as httpOnly on every request so the raw access/refresh
 * tokens are never persisted in JS-readable storage.
 *
 * The browser client is used only for the auth *flow* (signIn / signUp / signOut /
 * onAuthStateChange) and to read the current user for UI. The dashboard's data
 * calls never carry the token from here — they go through the same-origin server
 * proxy (/api/proxy/[...path]) which reads the cookie session server-side and
 * forwards the bearer to the control plane. See src/lib/api.ts.
 */
export function createClient(): SupabaseClient {
  const { url, publishableKey } = getSupabaseEnv();
  return createBrowserClient(url, publishableKey);
}
