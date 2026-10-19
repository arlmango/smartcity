import http from "node:http";
import { expect, test } from "@playwright/test";

/**
 * Integration (real standalone server + real /api proxy, stub upstream recording headers):
 * a client-supplied X-Forwarded-For must never reach the API (P2-2 rate-limit spoofing).
 * The stub listens on the API_INTERNAL_URL port configured in playwright.config.ts.
 */
const UPSTREAM_PORT = Number(process.env.E2E_UPSTREAM_PORT ?? 3109);

test("spoofed X-Forwarded-For does not reach the upstream API", async ({ request }) => {
  const seen: http.IncomingHttpHeaders[] = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });
  await new Promise<void>((r) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", r));
  try {
    const res = await request.get("/api/health", {
      headers: { "X-Forwarded-For": "6.6.6.6, 7.7.7.7", Forwarded: "for=6.6.6.6", "X-Real-IP": "6.6.6.6" },
    });
    expect(res.status()).toBe(200);
    const res2 = await request.get("/api/health");
    expect(res2.status()).toBe(200);
    expect(seen).toHaveLength(2);
    for (const h of seen) {
      expect(h["x-forwarded-for"]).toBe("127.0.0.1"); // the real socket peer of the web server
      expect(h["forwarded"]).toBeUndefined();
      expect(h["x-real-ip"]).toBeUndefined();
    }
  } finally {
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});
