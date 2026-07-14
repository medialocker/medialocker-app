import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getSupabaseEnv } from "./lib/supabase-env";

/**
 * Build the dashboard Content-Security-Policy carrying a per-request `nonce`.
 *
 * The HTML-host CSP lives here (not in Caddy) so it can mint a fresh nonce per
 * request and hand it to Next: when Next sees a CSP with `'nonce-…'` on the
 * INCOMING request header it stamps that same nonce onto every inline
 * bootstrap/hydration <script> it emits, which lets us drop `'unsafe-inline'`
 * from script-src. `'strict-dynamic'` then lets those nonce'd scripts load the
 * rest of the chunk graph (so we don't need to allowlist every script host).
 *
 * Hosts (s3/api/supabase) are derived from NEXT_PUBLIC_* with the medialocker.io
 * production defaults; styles keep `'unsafe-inline'` (Tailwind/Next inject inline
 * <style> and there is no style-nonce pattern), and `'wasm-unsafe-eval'` stays
 * for the @google/model-viewer Draco/meshopt WASM used by the shared MediaViewer.
 */
function buildCsp(nonce: string): string {
  const baseDomain = process.env.NEXT_PUBLIC_BASE_DOMAIN || "medialocker.io";
  const s3Host = `https://*.s3.${baseDomain}`;

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || `https://api.${baseDomain}`;
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || `https://supabase.${baseDomain}`;
  // Supabase Realtime opens a WebSocket on the same host with the ws(s) scheme.
  const supabaseWss = supabaseUrl.replace(/^http/, "ws");

  // Local dev (BASE_DOMAIN=localhost): the strict nonce/strict-dynamic policy
  // assumes Next stamps the nonce on its script tags; over plain-HTTP localhost
  // that path doesn't apply, so use a relaxed policy that still scopes hosts but
  // lets the bundle execute and allows the local API + MinIO presigned URLs
  // (http://localhost:{3002,9000}). Production is unaffected.
  if (baseDomain === "localhost") {
    const local = "http://localhost:3002 http://localhost:9000";
    return [
      `default-src 'self'`,
      `script-src 'self' 'unsafe-inline' 'unsafe-eval'`,
      `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
      `img-src 'self' data: blob: ${local}`,
      `media-src 'self' blob: ${local}`,
      `font-src 'self' data: https://fonts.gstatic.com`,
      `worker-src 'self' blob:`,
      `connect-src 'self' ${local} ${supabaseUrl} ${supabaseWss}`,
      `frame-src 'self' ${local}`,
      `object-src 'self' ${local}`,
      `frame-ancestors 'none'`,
      `base-uri 'self'`,
      `form-action 'self'`,
    ].join("; ");
  }

  return [
    `default-src 'self'`,
    // NOTE: a per-request nonce + 'strict-dynamic' only works when every route is
    // dynamically rendered so Next can stamp the nonce onto its <script> tags.
    // The dashboard has statically-prerendered routes (e.g. /login), whose baked
    // HTML can't carry a fresh per-request nonce, so 'strict-dynamic' blocked ALL
    // chunks. Use 'self' 'unsafe-inline' so both static and dynamic routes load.
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `img-src 'self' data: blob: ${s3Host}`,
    `media-src 'self' blob: ${s3Host}`,
    `font-src 'self' data: https://fonts.gstatic.com`,
    `worker-src 'self' blob:`,
    `connect-src 'self' ${apiUrl} ${supabaseUrl} ${supabaseWss} ${s3Host}`,
    `frame-src 'self' ${s3Host}`,
    `object-src 'self' ${s3Host}`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
  ].join("; ");
}

/**
 * §2.6 — Auth middleware. Refreshes the Supabase session on every request and
 * re-issues the session as **httpOnly cookies** so the browser JS never holds the
 * raw access/refresh token. This is the standard `@supabase/ssr` Next.js pattern:
 * the request cookies are read, `getClaims()` triggers a refresh if the access
 * token is stale, and any rotated tokens are written back onto BOTH the request
 * (so downstream handlers in this pass see them) and the response (so the browser
 * stores the refreshed httpOnly cookies).
 *
 * Do not run arbitrary logic between createServerClient and getClaims — keep the
 * refresh first so cookie rotation is never skipped.
 *
 * The middleware also mints the per-request CSP nonce and sets the strict CSP
 * (see buildCsp). The nonce is injected into the request headers Next reads when
 * server-rendering (so its inline scripts get the nonce) and echoed on the
 * response CSP header sent to the browser.
 */
export async function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce);

  // Hand the nonce + CSP to Next's renderer via the request headers, so the
  // inline hydration <script> tags Next emits are stamped with this same nonce.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  // The parent (httpOnly) cookie domain. Unset by default → cookies stay
  // per-origin (local dev). Set to a leading-dot parent (e.g. `.medialocker.io`)
  // to share the session across subdomains of the parent domain.
  const cookieDomain = process.env.NEXT_PUBLIC_COOKIE_DOMAIN || undefined;

  const { url, publishableKey } = getSupabaseEnv();
  const supabase = createServerClient(
    url,
    publishableKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request: { headers: requestHeaders } });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, {
              ...options,
              ...(cookieDomain ? { domain: cookieDomain } : {}),
            });
          }
        },
      },
    },
  );

  // IMPORTANT: refresh first. getClaims() validates/refreshes the session and
  // drives the cookie rotation in setAll above.
  const { data: claims } = await supabase.auth.getClaims();

  // Server-side route protection (P2.56): the client-side guard in app-layout
  // can flash protected UI before it redirects (and is bypassable). Enforce auth
  // here too — unauthenticated requests for any non-public page are 307'd to
  // /login server-side, before the dashboard ever renders. `/api/proxy` is left
  // alone (it returns its own 401s) and public auth pages are allow-listed.
  const { pathname } = request.nextUrl;
  const isPublicPath =
    pathname === "/login" ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/api/");
  if (!claims && !isPublicPath) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    // Preserve where the user was headed so login can bounce them back.
    if (pathname && pathname !== "/") loginUrl.searchParams.set("redirect", pathname);
    const redirect = NextResponse.redirect(loginUrl);
    redirect.headers.set("Content-Security-Policy", csp);
    redirect.headers.set("x-nonce", nonce);
    return redirect;
  }

  // Echo the CSP (and nonce) on the response sent to the browser. Set after the
  // Supabase call so it survives any response reassignment inside setAll.
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("x-nonce", nonce);

  return response;
}

export const config = {
  // Run on everything except static assets and image optimization. The session
  // cookies need to be refreshed for page loads, the proxy route, and the
  // auth callback alike.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
