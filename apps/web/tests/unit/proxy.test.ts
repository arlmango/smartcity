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
    ["GET", ["places"]],
    ["GET", ["places", "8b2c-uuid"]],
    ["GET", ["search"]],
    ["POST", ["recommend"]],
    ["POST", ["route"]],
  ])("allows %s %j", (m, segs) => expect(matchRoute(m, segs)).not.toBeNull());

  it.each([
    ["GET", ["map", "secrets"]],
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

  it("maps upstream connection failure to 502 api_unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("ECONNREFUSED"));
    const res = await proxy(new Request("http://web/api/health"), ["health"]);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("api_unreachable");
  });
});
