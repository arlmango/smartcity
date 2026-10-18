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
  query: boolean;
  timeoutMs: number;
}

export const ROUTES: RouteRule[] = [
  { method: "GET", pattern: /^health$/, query: false, timeoutMs: 10_000 },
  { method: "GET", pattern: /^ready$/, query: false, timeoutMs: 15_000 },
  { method: "GET", pattern: /^coverage$/, query: false, timeoutMs: 15_000 },
  { method: "GET", pattern: /^map\/(buildings|roads|water|green|coverage)$/, query: false, timeoutMs: 30_000 },
  { method: "GET", pattern: /^places$/, query: true, timeoutMs: 15_000 },
  { method: "GET", pattern: /^places\/[A-Za-z0-9._:~-]{1,128}$/, query: false, timeoutMs: 15_000 },
  { method: "GET", pattern: /^search$/, query: true, timeoutMs: 15_000 },
  // Local CPU generation can take minutes; the API enforces its own REQUEST_TIMEOUT_SECONDS (200 s).
  { method: "POST", pattern: /^recommend$/, query: false, timeoutMs: 210_000 },
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

// x-forwarded-for lets the API rate-limit per client (API trusts only the last hop).
const FORWARD_REQ_HEADERS = ["accept", "content-type", "if-none-match", "accept-language", "x-forwarded-for"];
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
    target.search = search;
  }

  const headers = new Headers();
  for (const h of FORWARD_REQ_HEADERS) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }

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
    if (upstream.status >= 300 && upstream.status < 400) return json(502, "bad_upstream", "API вернул неожиданное перенаправление.");
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch {
    if (request.signal.aborted) return json(499, "client_closed", "Запрос отменён.");
    if (controller.signal.aborted) return json(504, "upstream_timeout", "API не ответил вовремя.");
    return json(502, "api_unreachable", "API недоступен. Проверьте, что сервис запущен.");
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onClientAbort);
  }
}
