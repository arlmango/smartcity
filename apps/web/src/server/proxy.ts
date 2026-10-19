/**
 * Server-side same-origin proxy for /api/* → API_INTERNAL_URL (read at request time,
 * so the same Docker image works with any API address). Only whitelisted paths and
 * methods are forwarded; the upstream host comes from server env only, never from
 * the request (no open proxy / SSRF).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_API = "http://localhost:8000";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUERY_CHARS = 2048;

type Method = "GET" | "POST";

interface RouteRule {
  method: Method;
  pattern: RegExp;
  /** true: forward the query string; a RegExp: forward it only when it matches exactly, else drop it. */
  query: boolean | RegExp;
  timeoutMs: number;
}

export const ROUTES: RouteRule[] = [
  { method: "GET", pattern: /^health$/, query: false, timeoutMs: 10_000 },
  { method: "GET", pattern: /^ready$/, query: false, timeoutMs: 15_000 },
  { method: "GET", pattern: /^coverage$/, query: false, timeoutMs: 15_000 },
  { method: "GET", pattern: /^map\/(buildings|roads|water|green|coverage)$/, query: false, timeoutMs: 30_000 },
  { method: "GET", pattern: /^basemap(\/boundary)?$/, query: false, timeoutMs: 10_000 },
  // ?v=<archive version> is a cache key (a rebuild changes the tile URLs); nothing else is forwarded.
  { method: "GET", pattern: /^tiles\/(base|buildings)\/\d{1,2}\/\d{1,6}\/\d{1,6}$/, query: /^\?v=[0-9a-f]{1,32}$/, timeoutMs: 15_000 },
  { method: "GET", pattern: /^places$/, query: true, timeoutMs: 15_000 },
  { method: "GET", pattern: /^places\/[A-Za-z0-9._:~-]{1,128}$/, query: false, timeoutMs: 15_000 },
  { method: "GET", pattern: /^search$/, query: true, timeoutMs: 15_000 },
  // Local CPU generation can take minutes; the API enforces its own REQUEST_TIMEOUT_SECONDS (200 s).
  { method: "POST", pattern: /^recommend$/, query: false, timeoutMs: 210_000 },
  { method: "POST", pattern: /^recommend\/stream$/, query: false, timeoutMs: 210_000 },
  { method: "POST", pattern: /^route$/, query: false, timeoutMs: 30_000 },
];

export function matchRoute(method: string, segments: string[]): RouteRule | null {
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes("/") || s.includes("\\"))) return null;
  const p = segments.join("/");
  return ROUTES.find((r) => r.method === method && r.pattern.test(p)) ?? null;
}

export function apiBase(): URL {
  const raw = process.env.API_INTERNAL_URL || DEFAULT_API;
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("API_INTERNAL_URL must be http(s)");
  return u;
}

const json = (status: number, error: string, message: string): Response =>
  new Response(JSON.stringify({ error, message, request_id: null }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const FORWARD_REQ_HEADERS = ["accept", "content-type", "if-none-match", "accept-language"];

/**
 * X-Forwarded-For for the API's per-client rate limit (API trusts only the last hop).
 * The value is trustworthy only when server-preload.cjs replaced the client header with the
 * socket address in this process; otherwise nothing is forwarded (the API then sees the web
 * server's address — a shared limit, but never a client-chosen one).
 */
export function forwardedForToSend(incoming: string | null): string | null {
  if ((globalThis as { __smartcityXffNormalized?: boolean }).__smartcityXffNormalized !== true) return null;
  if (!incoming) return null;
  const v = incoming.trim();
  // The preload always leaves exactly one address; anything else is not forwarded.
  return /^[0-9A-Fa-f.:]{2,45}$/.test(v) ? v : null;
}
const FORWARD_RES_HEADERS = ["content-type", "etag", "cache-control", "retry-after", "x-request-id", "last-modified"];

/** Optional dev-only override: serve map layers from local GeoJSON files (never in production). */
async function devMapFile(segments: string[]): Promise<Response | null> {
  const dir = process.env.WEB_DEV_MAP_DIR;
  if (!dir || process.env.NODE_ENV === "production") return null;
  if (segments[0] !== "map" || segments.length !== 2) return null;
  const layer = segments[1] ?? "";
  if (!/^(buildings|roads|water|green|coverage)$/.test(layer)) return null;
  try {
    const body = await readFile(path.join(dir, `${layer}.geojson`));
    return new Response(body, { status: 200, headers: { "content-type": "application/geo+json", "cache-control": "no-store" } });
  } catch {
    return null;
  }
}

/**
 * Map data (vector tiles, GeoJSON layers) is compressed here: Node's fetch has already decoded the
 * upstream body, and Next.js does not compress route-handler responses. Streaming endpoints (NDJSON)
 * are never compressed, so their chunks are not held back.
 */
export function shouldCompress(segments: string[], upstream: Response, request: Request): boolean {
  if (!/^(tiles|map|basemap)$/.test(segments[0] ?? "")) return false;
  if (upstream.status !== 200) return false;
  if (!/\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")) return false;
  return /^application\/(x-protobuf|geo\+json|json)\b/.test(upstream.headers.get("content-type") ?? "");
}

export async function proxy(request: Request, segments: string[]): Promise<Response> {
  const method = request.method.toUpperCase();
  const rule = matchRoute(method, segments);
  if (!rule) return json(404, "not_found", "Неизвестный адрес API.");

  const dev = await devMapFile(segments);
  if (dev) return dev;

  let base: URL;
  try {
    base = apiBase();
  } catch {
    return json(500, "misconfigured", "Адрес API на сервере настроен неверно.");
  }
  const target = new URL(`/api/${segments.join("/")}`, base);
  if (rule.query) {
    const search = new URL(request.url).search;
    if (search.length > MAX_QUERY_CHARS) return json(414, "query_too_long", "Слишком длинный запрос.");
    if (rule.query === true || rule.query.test(search)) target.search = search;
  }

  const headers = new Headers();
  for (const h of FORWARD_REQ_HEADERS) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  const xff = forwardedForToSend(request.headers.get("x-forwarded-for"));
  if (xff) headers.set("x-forwarded-for", xff);

  let body: ArrayBuffer | undefined;
  if (method === "POST") {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return json(413, "payload_too_large", "Запрос слишком большой.");
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return json(413, "payload_too_large", "Запрос слишком большой.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), rule.timeoutMs);
  const onClientAbort = () => controller.abort(new Error("client aborted"));
  request.signal.addEventListener("abort", onClientAbort);
  try {
    const upstream = await fetch(target, { method, headers, body, signal: controller.signal, redirect: "manual", cache: "no-store" });
    const out = new Headers();
    for (const h of FORWARD_RES_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) return json(502, "bad_upstream", "API вернул неожиданное перенаправление.");
    const bodyless = upstream.status === 204 || upstream.status === 304;
    if (!bodyless && upstream.body && shouldCompress(segments, upstream, request)) {
      out.set("content-encoding", "gzip");
      // Different bytes than the identity body: a weak validator (the API compares ETags weakly).
      const etag = out.get("etag");
      if (etag && !etag.startsWith("W/")) out.set("etag", `W/${etag}`);
      out.append("vary", "Accept-Encoding");
      return new Response(upstream.body.pipeThrough(new CompressionStream("gzip")), { status: upstream.status, headers: out });
    }
    return new Response(bodyless ? null : upstream.body, { status: upstream.status, headers: out });
  } catch {
    if (request.signal.aborted) return json(499, "client_closed", "Запрос отменён.");
    if (controller.signal.aborted) return json(504, "upstream_timeout", "API не ответил вовремя.");
    return json(502, "api_unreachable", "API недоступен. Проверьте, что сервис запущен.");
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onClientAbort);
  }
}
