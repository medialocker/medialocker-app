// Resolve the public Supabase Cloud config (project URL + publishable key) used by
// the browser/server auth clients. Fails fast on misconfiguration so a real deploy
// can't silently run against the wrong project — EXCEPT during the Next
// production build, where static prerender runs without the runtime env; there we
// fall back to harmless placeholders so the build completes (no auth happens at
// build time). At runtime (browser or server request) a missing value throws.
//
// The publishable key (sb_publishable_…) is Supabase's current client-side key,
// replacing the legacy anon key; it's a drop-in for createBrowserClient/
// createServerClient.
const PLACEHOLDER_URL = "https://placeholder.supabase.co";
const PLACEHOLDER_PUBLISHABLE = "sb_publishable_placeholder";

export function getSupabaseEnv(): { url: string; publishableKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (url && publishableKey) return { url, publishableKey };
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return { url: url ?? PLACEHOLDER_URL, publishableKey: publishableKey ?? PLACEHOLDER_PUBLISHABLE };
  }
  throw new Error(
    "Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to the Supabase Cloud project values (inlined at build time).",
  );
}
