// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeForwardedFor, parseTrustedHops } from "../../forwarded-for.cjs";
import { forwardedForToSend, proxy } from "@/server/proxy";

describe("normalizeForwardedFor (P2-2 rate-limit spoofing)", () => {
  it("without trusted proxies ignores client XFF and uses the socket address", () => {
    expect(normalizeForwardedFor("6.6.6.6", "10.0.0.7", 0)).toBe("10.0.0.7");
    expect(normalizeForwardedFor("6.6.6.6, 7.7.7.7", "::ffff:10.0.0.7", 0)).toBe("10.0.0.7");
    expect(normalizeForwardedFor(undefined, "::1", 0)).toBe("::1");
    expect(normalizeForwardedFor("1.2.3.4", undefined, 0)).toBe("unknown");
  });

  it("with N trusted hops takes the entry before the last N (peer appended)", () => {
    // client 203.0.113.5 → proxy (appends client) → web; peer = proxy
    expect(normalizeForwardedFor("203.0.113.5", "172.18.0.2", 1)).toBe("203.0.113.5");
    // spoofed prefix by the client is ignored
    expect(normalizeForwardedFor("6.6.6.6, 203.0.113.5", "172.18.0.2", 1)).toBe("203.0.113.5");
    // two proxies: cdn appended client, lb appended cdn
    expect(normalizeForwardedFor("6.6.6.6, 203.0.113.5, 198.51.100.9", "172.18.0.2", 2)).toBe("203.0.113.5");
    expect(normalizeForwardedFor(["6.6.6.6", "203.0.113.5"], "172.18.0.2", 1)).toBe("203.0.113.5");
  });

  it("falls back to the peer when the chain is too short or the entry is not an IP", () => {
    expect(normalizeForwardedFor("", "172.18.0.2", 1)).toBe("172.18.0.2");
    expect(normalizeForwardedFor("203.0.113.5", "172.18.0.2", 3)).toBe("172.18.0.2");
    expect(normalizeForwardedFor("evil<script>, x", "172.18.0.2", 1)).toBe("172.18.0.2");
    expect(normalizeForwardedFor("999.1.1.1", "172.18.0.2", 1)).toBe("172.18.0.2");
  });

  it("parses WEB_TRUSTED_PROXY_HOPS safely", () => {
    expect(parseTrustedHops(undefined)).toBe(0);
    expect(parseTrustedHops("abc")).toBe(0);
    expect(parseTrustedHops("-2")).toBe(0);
    expect(parseTrustedHops("2")).toBe(2);
    expect(parseTrustedHops("99")).toBe(10);
  });
});

describe("proxy forwards XFF only after preload normalisation", () => {
  afterEach(() => {
    delete (globalThis as { __smartcityXffNormalized?: boolean }).__smartcityXffNormalized;
    vi.restoreAllMocks();
  });

  it("drops XFF when the preload is not active", async () => {
    expect(forwardedForToSend("6.6.6.6")).toBeNull();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await proxy(new Request("http://web/api/health", { headers: { "x-forwarded-for": "6.6.6.6" } }), ["health"]);
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("x-forwarded-for")).toBeNull();
  });

  it("forwards the single normalised address when the preload is active", async () => {
    (globalThis as { __smartcityXffNormalized?: boolean }).__smartcityXffNormalized = true;
    expect(forwardedForToSend("6.6.6.6, 7.7.7.7")).toBeNull();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await proxy(new Request("http://web/api/health", { headers: { "x-forwarded-for": "10.0.0.7" } }), ["health"]);
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("x-forwarded-for")).toBe("10.0.0.7");
  });
});
