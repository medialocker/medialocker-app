import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

/**
 * §2.6 — PKCE / OAuth callback. Supabase redirects here with a `?code=` after an
 * OAuth or email-confirmation flow. We exchange the code for a session server-side;
 * `@supabase/ssr` writes the resulting session as httpOnly cookies via the route
 * handler's cookie store (createServerClient's setAll), so the browser never sees
 * the raw tokens.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = await createServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
