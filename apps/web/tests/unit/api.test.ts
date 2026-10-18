import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getCoverage, postRecommend } from "@/lib/api";
import { EMPTY_CONSTRAINTS, type RecommendRequest } from "@/lib/contracts";
import { coverage, okResponse } from "../fixtures/synthetic";

const req: RecommendRequest = {
  origin: { lat: 51.09, lon: 71.414 },
  query: "",
  time_budget_min: 40,
  return_to_start: true,
  travel_mode: "walking",
  interests: [],
  constraints: EMPTY_CONSTRAINTS,
  conversation_context: [],
  start_time: null,
  client_request_id: "client-req-0001",
};

const mockFetch = (status: number, body: unknown) =>
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

afterEach(() => vi.restoreAllMocks());

describe("api client", () => {
  it("returns validated data", async () => {
    mockFetch(200, coverage);
    await expect(getCoverage()).resolves.toMatchObject({ place_count: 3 });
  });

  it("turns an invalid response into an ApiError, not a crash", async () => {
    mockFetch(200, { ...coverage, place_count: "many" });
    await expect(getCoverage()).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("surfaces server error messages as text and marks 503 retryable", async () => {
    mockFetch(503, { error: "llm_unavailable", message: "Сервис перегружен", request_id: "r1" });
    const err = await postRecommend(req, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("Сервис перегружен");
    expect((err as ApiError).retryable).toBe(true);
  });

  it("422 is not retryable", async () => {
    mockFetch(422, { error: "invalid_start_time", message: "bad" });
    const err = (await postRecommend(req, new AbortController().signal).catch((e: unknown) => e)) as ApiError;
    expect(err.retryable).toBe(false);
  });

  it("rejects a response for another client_request_id", async () => {
    mockFetch(200, okResponse("another-id-9999"));
    await expect(postRecommend(req, new AbortController().signal)).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("network failure → network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(getCoverage()).rejects.toMatchObject({ kind: "network" });
  });

  it("abort → aborted", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")));
      }),
    );
    const ctl = new AbortController();
    const p = postRecommend(req, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ kind: "aborted" });
  });
});
