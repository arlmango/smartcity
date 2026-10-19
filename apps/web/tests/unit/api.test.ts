import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getCoverage, postRecommend, postRecommendStream } from "@/lib/api";
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

describe("postRecommendStream (NDJSON)", () => {
  const ndjsonResponse = (lines: unknown[], chunkSplit = 7) => {
    const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        // deliver in small chunks so that lines are split across reads
        for (let i = 0; i < bytes.length; i += chunkSplit) c.enqueue(bytes.slice(i, i + chunkSplit));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  };
  const pre = { ...okResponse(req.client_request_id), mode: "retrieval_only" };

  it("delivers preliminary places first, then resolves with the final answer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      ndjsonResponse([
        { event: "preliminary", response: pre },
        { event: "final", response: okResponse(req.client_request_id) },
      ]),
    );
    const seen: string[] = [];
    const final = await postRecommendStream(req, new AbortController().signal, (r) => seen.push(r.mode));
    expect(seen).toEqual(["retrieval_only"]);
    expect(final.mode).toBe("live_rag");
  });

  it("an error event after preliminary rejects (the caller keeps the preliminary places)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      ndjsonResponse([
        { event: "preliminary", response: pre },
        { event: "error", error: { error: "timeout", message: "Превышено время", request_id: null } },
      ]),
    );
    let got = 0;
    await expect(postRecommendStream(req, new AbortController().signal, () => got++)).rejects.toMatchObject({
      kind: "http",
      status: 504,
    });
    expect(got).toBe(1);
  });

  it("rejects answers that belong to another request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      ndjsonResponse([{ event: "final", response: okResponse("someone-else-01") }]),
    );
    await expect(postRecommendStream(req, new AbortController().signal, () => {})).rejects.toBeInstanceOf(ApiError);
  });

  it("a stream that ends without a final event is a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(ndjsonResponse([{ event: "preliminary", response: pre }]));
    await expect(postRecommendStream(req, new AbortController().signal, () => {})).rejects.toMatchObject({ kind: "network" });
  });
});
