import { cookies } from "next/headers";
import { createServerClient as createSsrServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "./supabase-env";

/**
 * §2.6 — Server-side Supabase client bound to the request's httpOnly cookies
 * (via `@supabase/ssr` + Next `cookies()`). Use this in Server Components, Route
 * Handlers and Server Actions to read the authenticated session and the access
 * token *without ever exposing the token to the browser*.
 *
 * The access token read here is forwarded as the `Authorization: Bearer` header
 * to the control plane by the proxy route handler (app/api/proxy/[...path]).
 *
 * Cookie *writes* (token refresh) from Server Components are no-ops by design —
 * Next forbids setting cookies while rendering. The middleware owns refreshing
 * and re-issuing the session cookies; from a Route Handler the setAll below does
 * persist, which is what the /auth/callback (code exchange) and /auth/signout
 * handlers rely on.
 */
export async function createServerClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  // Parent cookie domain for cross-subdomain session sharing. Unset by default
  // → per-origin cookies (local dev); set to a leading-dot parent (e.g.
  // `.medialocker.io`) to share the session across subdomains of the parent domain.
  const cookieDomain = process.env.NEXT_PUBLIC_COOKIE_DOMAIN || undefined;
  const { url, publishableKey } = getSupabaseEnv();
  return createSsrServerClient(
    url,
    publishableKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, {
                ...options,
                ...(cookieDomain ? { domain: cookieDomain } : {}),
              });
            }
          } catch {
            // Called from a Server Component render — ignore; middleware refreshes.
          }
        },
      },
    },
  );
}
