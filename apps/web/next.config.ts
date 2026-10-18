import path from "node:path";
import type { NextConfig } from "next";

/**
 * API calls from the browser go to same-origin /api/*. They are proxied by the
 * route handler in src/app/api/[...path]/route.ts, which reads API_INTERNAL_URL
 * at runtime (rewrites would be frozen at build time, which breaks Docker).
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "geolocation=(self), camera=(), microphone=()" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname),
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
