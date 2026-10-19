import path from "node:path";
import type { NextConfig } from "next";

/**
 * API calls from the browser go to same-origin /api/*. They are proxied by the
 * route handler in src/app/api/[...path]/route.ts, which reads API_INTERNAL_URL
 * at runtime (rewrites would be frozen at build time, which breaks Docker).
 */
const isDev = process.env.NODE_ENV === "development";

/**
 * CSP. Next.js App Router without per-request nonces injects inline bootstrap scripts
 * (self.__next_f.push), so script-src needs 'unsafe-inline' (no 'unsafe-eval' in production).
 * MapLibre runs its workers from blob: URLs; styles use React inline style attributes.
 * All data, glyphs, fonts and vector tiles are same-origin. The only external host is the optional
 * satellite underlay (EOX Sentinel-2 cloudless raster tiles), fetched by the browser in satellite mode.
 */
const SATELLITE_ORIGIN = "https://tiles.maps.eox.at";
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${SATELLITE_ORIGIN}`,
  "font-src 'self' data:",
  `connect-src 'self' ${SATELLITE_ORIGIN}${isDev ? " ws: wss:" : ""}`,
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: CSP },
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
