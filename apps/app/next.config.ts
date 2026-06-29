import type { NextConfig } from "next";

// Baseline security headers applied at the Next layer so they hold even when the
// container is reached directly (not only behind Caddy). Content-Security-Policy
// is intentionally NOT set here — it is owned by the edge (infra/caddy/Caddyfile)
// to avoid two CSP headers whose intersection could silently break the app.
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@medialocker/ui"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
