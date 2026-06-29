import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

/**
 * §2.6 — Same-origin control-plane proxy.
 *
 * The dashboard's API client (src/lib/api.ts) calls `/api/proxy/<path>` instead
 * of hitting NEXT_PUBLIC_API_URL directly. This handler runs server-side, reads
 * the Supabase session from the **httpOnly cookies** (never exposed to the
 * browser), and forwards the request to the real control plane with the
 * `Authorization: Bearer <access_token>` header attached here. The raw token
 * therefore stays entirely server-side — XSS on the dashboard can call the proxy
 * (same as any logged-in action) but can never read or exfiltrate the token.
 *
 * Responses are streamed straight back, so binary endpoints (e.g.
 * /api/media/:id/thumbnail) work unchanged.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "https://api.medialocker.io";

// Hop-by-hop / host-specific headers we must not forward in either direction.
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "authorization", // we attach our own from the session
  "cookie", // never leak the session cookies to the upstream API
]);
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

/**
 * Reject anything that could escape the intended upstream path or smuggle a
 * different origin: dot-segments (`.`/`..`) in raw OR percent-encoded form,
 * backslashes, null/control bytes, and absolute or protocol-relative segments.
 * Segments arrive already split on `/` by Next, so a segment must never itself
 * contain a separator after decoding. (P2.57)
 */
function isUnsafeSegment(raw: string): boolean {
  if (raw === "") return true; // empty segment → `//` collapse / protocol-relative
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return true; // malformed percent-encoding
  }
  const candidates = [raw, decoded];
  return candidates.some((s) => {
    if (s === "." || s === "..") return true;
    if (s.includes("..")) return true; // covers `..`, `%2e%2e`, `x/..`
    if (s.includes("/") || s.includes("\\")) return true; // separators must not survive a split
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(s)) return true; // null / control bytes
    return false;
  });
}

async function forward(req: NextRequest, path: string[]): Promise<Response> {
  if (path.some(isUnsafeSegment)) {
    return new Response("Invalid path", { status: 400 });
  }

  const supabase = await createServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;

  const upstreamUrl = `${API_BASE}/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  if (token) headers.set("authorization", `Bearer ${token}`);

  const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50 MB limit
  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  let body: BodyInit | null | undefined = undefined;
  if (hasBody && req.body) {
    const contentLength = req.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_BODY_SIZE) {
      return new Response("Payload too large", { status: 413 });
    }
    if (!contentLength) {
      let totalBytes = 0;
      const reader = (req.body as ReadableStream).getReader();
      body = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          totalBytes += (value as Uint8Array).byteLength;
          if (totalBytes > MAX_BODY_SIZE) {
            reader.cancel();
            controller.error(new Error("Payload too large"));
            return;
          }
          controller.enqueue(value);
        },
      });
    } else {
      body = req.body as any;
    }
  }

  const upstream = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    // Stream the body through instead of buffering it in memory (F1).
    // Duplex must be "half" when the body is a ReadableStream.
    body: hasBody ? (body as any) : undefined,
    duplex: hasBody ? "half" : undefined,
    redirect: "manual",
    cache: "no-store",
    signal: req.signal,
  } as any);

  const resHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) resHeaders.set(key, value);
  });

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders,
  });
}

type Ctx = { params: Promise<{ path: string[] }> };

async function handler(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  return forward(req, path ?? []);
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const HEAD = handler;

// Forwarded bodies can be binary/large; opt out of static optimization.
export const dynamic = "force-dynamic";
