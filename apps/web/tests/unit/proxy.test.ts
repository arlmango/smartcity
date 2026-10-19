// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchRoute, proxy } from "@/server/proxy";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.API_INTERNAL_URL;
});

describe("API proxy whitelist", () => {
  it.each([
    ["GET", ["health"]],
    ["GET", ["ready"]],
    ["GET", ["coverage"]],
    ["GET", ["map", "buildings"]],
    ["GET", ["tiles", "base", "14", "11441", "5486"]],
    ["GET", ["tiles", "buildings", "15", "0", "0"]],
    ["GET", ["basemap"]],
    ["GET", ["basemap", "boundary"]],
    ["GET", ["places"]],
    ["GET", ["places", "8b2c-uuid"]],
    ["GET", ["search"]],
    ["POST", ["recommend"]],
    ["POST", ["route"]],
  ])("allows %s %j", (m, segs) => expect(matchRoute(m, segs)).not.toBeNull());

  it.each([
    ["GET", ["map", "secrets"]],
    ["GET", ["tiles", "satellite", "1", "0", "0"]],
    ["GET", ["tiles", "base", "1", "0"]],
    ["GET", ["tiles", "base", "a", "0", "0"]],
    ["GET", ["tiles", "base", "999", "0", "0"]],
    ["GET", ["basemap", "manifest.json"]],
    ["GET", ["recommend"]],
    ["POST", ["health"]],
    ["GET", ["..", "admin"]],
    ["GET", ["places", "a/b"]],
    ["GET", ["internal", "metrics"]],
    ["DELETE", ["places", "x"]],
  ])("blocks %s %j", (m, segs) => expect(matchRoute(m, segs)).toBeNull());

  it("forwards only to API_INTERNAL_URL with the query for search", async () => {
    process.env.API_INTERNAL_URL = "http://api.internal:8000";
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const res = await proxy(new Request("http://web/api/search?q=%D0%BA%D0%BE%D1%84%D0%B5"), ["search"]);
    expect(res.status).toBe(200);
    const url = spy.mock.calls[0]![0] as URL;
    expect(url.toString()).toBe("http://api.internal:8000/api/search?q=%D0%BA%D0%BE%D1%84%D0%B5");
  });

  it("does not forward the query string for non-query routes", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await proxy(new Request("http://web/api/ready?url=http://evil"), ["ready"]);
    expect((spy.mock.calls[0]![0] as URL).toString()).toBe("http://localhost:8000/api/ready");
  });

  it("returns 404 JSON for non-whitelisted paths without calling upstream", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await proxy(new Request("http://web/api/admin"), ["admin"]);
    expect(res.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies", async () => {
    const big = "x".repeat(70 * 1024);
    const res = await proxy(new Request("http://web/api/recommend", { method: "POST", body: big }), ["recommend"]);
    expect(res.status).toBe(413);
  });

  it("passes 304 Not Modified and 204 No Content through without a body (tile caching)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag: '"t1"', "cache-control": "public, max-age=86400" } }));
    const r304 = await proxy(new Request("http://web/api/tiles/base/14/1/1", { headers: { "if-none-match": '"t1"' } }), ["tiles", "base", "14", "1", "1"]);
    expect(r304.status).toBe(304);
    expect(r304.headers.get("etag")).toBe('"t1"');
    expect(await r304.text()).toBe("");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 204 }));
    const r204 = await proxy(new Request("http://web/api/tiles/base/14/1/2"), ["tiles", "base", "14", "1", "2"]);
    expect(r204.status).toBe(204);
  });

  it("gzips tiles for clients that accept it, never the NDJSON stream", async () => {
    const tile = new Uint8Array(4000).fill(7);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(tile, { status: 200, headers: { "content-type": "application/x-protobuf" } }));
    const res = await proxy(new Request("http://web/api/tiles/base/14/1/1", { headers: { "accept-encoding": "gzip, br" } }), ["tiles", "base", "14", "1", "1"]);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const plain = new Uint8Array(await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    expect(plain).toEqual(tile);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(tile, { status: 200, headers: { "content-type": "application/x-protobuf" } }));
    const noGzip = await proxy(new Request("http://web/api/tiles/base/14/1/1"), ["tiles", "base", "14", "1", "1"]);
    expect(noGzip.headers.get("content-encoding")).toBeNull();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}\n", { status: 200, headers: { "content-type": "application/x-ndjson" } }));
    const stream = await proxy(
      new Request("http://web/api/recommend/stream", { method: "POST", body: "{}", headers: { "accept-encoding": "gzip" } }),
      ["recommend", "stream"],
    );
    expect(stream.headers.get("content-encoding")).toBeNull();
  });

  it("forwards only a valid ?v= cache key for tiles; gzip variants get a weak ETag", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(new Uint8Array(2000), { status: 200, headers: { "content-type": "application/x-protobuf", etag: '"t9"' } }),
    );
    const seg = ["tiles", "base", "14", "1", "1"];
    const ok = await proxy(new Request("http://web/api/tiles/base/14/1/1?v=ab12", { headers: { "accept-encoding": "gzip" } }), seg);
    expect((spy.mock.calls[0]![0] as URL).search).toBe("?v=ab12");
    expect(ok.headers.get("etag")).toBe('W/"t9"');
    await proxy(new Request("http://web/api/tiles/base/14/1/1?v=ab12&url=http://evil"), seg);
    expect((spy.mock.calls[1]![0] as URL).search).toBe("");
    const plain = await proxy(new Request("http://web/api/tiles/base/14/1/1"), seg);
    expect(plain.headers.get("etag")).toBe('"t9"');
  });

  it("forwards If-None-Match upstream", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 304 }));
    await proxy(new Request("http://web/api/tiles/base/14/1/1", { headers: { "if-none-match": '"abc"' } }), ["tiles", "base", "14", "1", "1"]);
    expect((spy.mock.calls[0]![1] as RequestInit).headers).toBeInstanceOf(Headers);
    expect(((spy.mock.calls[0]![1] as RequestInit).headers as Headers).get("if-none-match")).toBe('"abc"');
  });

  it("still refuses real redirects", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://evil" } }));
    const res = await proxy(new Request("http://web/api/health"), ["health"]);
    expect(res.status).toBe(502);
  });

  it("maps upstream connection failure to 502 api_unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("ECONNREFUSED"));
    const res = await proxy(new Request("http://web/api/health"), ["health"]);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("api_unreachable");
  });
});
