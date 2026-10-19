import { describe, expect, it } from "vitest";
import type { RecommendRequest } from "@/lib/contracts";
import { EMPTY_CONSTRAINTS } from "@/lib/contracts";
import {
  MAX_CONTEXT_TURNS,
  appendContext,
  initialRecommendState,
  recommendReducer,
  type RecommendState,
} from "@/lib/recommendState";
import { okResponse, recB } from "../fixtures/synthetic";

const req = (id: string): RecommendRequest => ({
  origin: { lat: 51.09, lon: 71.414 },
  query: "",
  time_budget_min: 40,
  return_to_start: true,
  travel_mode: "walking",
  interests: [],
  constraints: EMPTY_CONSTRAINTS,
  conversation_context: [],
  start_time: null,
  client_request_id: id,
});

const start = (s: RecommendState, id: string, turn = "q") =>
  recommendReducer(s, { type: "start", request: req(id), at: 0, userTurn: turn });

describe("T24: stale responses never overwrite the current request", () => {
  it("ignores the answer of a superseded request", () => {
    let s = start(initialRecommendState, "request-old-1");
    s = start(s, "request-new-2");
    s = recommendReducer(s, { type: "success", id: "request-old-1", response: okResponse("request-old-1") });
    expect(s.status).toBe("loading");
    expect(s.response).toBeNull();
    s = recommendReducer(s, { type: "success", id: "request-new-2", response: okResponse("request-new-2", [recB]) });
    expect(s.status).toBe("success");
    expect(s.response?.client_request_id).toBe("request-new-2");
  });

  it("ignores a late old answer after the new one is shown", () => {
    let s = start(initialRecommendState, "request-old-1");
    s = start(s, "request-new-2");
    s = recommendReducer(s, { type: "success", id: "request-new-2", response: okResponse("request-new-2", [recB]) });
    const after = recommendReducer(s, { type: "success", id: "request-old-1", response: okResponse("request-old-1") });
    expect(after).toBe(s);
  });

  it("ignores a stale failure", () => {
    let s = start(initialRecommendState, "request-old-1");
    s = start(s, "request-new-2");
    s = recommendReducer(s, { type: "failure", id: "request-old-1", error: { kind: "network", message: "x", retryable: true } });
    expect(s.status).toBe("loading");
    expect(s.error).toBeNull();
  });

  it("rejects a response whose client_request_id does not match", () => {
    const s = start(initialRecommendState, "request-new-2");
    const after = recommendReducer(s, { type: "success", id: "request-new-2", response: okResponse("someone-else-9") });
    expect(after.status).toBe("loading");
  });

  it("ignores answers after cancel and restores the previous result", () => {
    let s = start(initialRecommendState, "request-one-1");
    s = recommendReducer(s, { type: "success", id: "request-one-1", response: okResponse("request-one-1") });
    s = start(s, "request-two-2");
    s = recommendReducer(s, { type: "cancel", id: "request-two-2" });
    expect(s.status).toBe("success");
    expect(s.cancelled).toBe(true);
    expect(s.response?.client_request_id).toBe("request-one-1");
    const late = recommendReducer(s, { type: "success", id: "request-two-2", response: okResponse("request-two-2") });
    expect(late).toBe(s);
  });

  it("cancel without a previous result goes back to idle", () => {
    let s = start(initialRecommendState, "request-one-1");
    s = recommendReducer(s, { type: "cancel", id: "request-one-1" });
    expect(s.status).toBe("idle");
  });

  it("retry with the same id after a failure succeeds", () => {
    let s = start(initialRecommendState, "request-one-1");
    s = recommendReducer(s, { type: "failure", id: "request-one-1", error: { kind: "http", message: "503", retryable: true } });
    expect(s.status).toBe("error");
    s = recommendReducer(s, { type: "start", request: s.request!, at: 1, userTurn: "q" });
    s = recommendReducer(s, { type: "success", id: "request-one-1", response: okResponse("request-one-1") });
    expect(s.status).toBe("success");
  });

  it("reset clears everything including context", () => {
    let s = start(initialRecommendState, "request-one-1", "кофе");
    s = recommendReducer(s, { type: "success", id: "request-one-1", response: okResponse("request-one-1") });
    expect(s.context.length).toBe(2);
    expect(recommendReducer(s, { type: "reset" })).toEqual(initialRecommendState);
  });
});

describe("conversation context", () => {
  it("keeps at most 6 turns and clips long text to 500 chars", () => {
    let ctx = appendContext([], "a".repeat(900), "b");
    expect(ctx[0]!.text.length).toBe(500);
    for (let i = 0; i < 10; i++) ctx = appendContext(ctx, `u${i}`, `a${i}`);
    expect(ctx.length).toBe(MAX_CONTEXT_TURNS);
    expect(ctx.at(-1)!.text).toBe("a9");
  });
});

describe("preliminary places (stream) survive a model timeout", () => {
  const pre = () => ({ ...okResponse("request-pre-1", [recB]), mode: "retrieval_only" as const });

  it("stores the preliminary answer only for the active request", () => {
    let s = start(initialRecommendState, "request-pre-1");
    s = recommendReducer(s, { type: "preliminary", id: "request-other-9", response: okResponse("request-other-9") });
    expect(s.preliminary).toBeNull();
    s = recommendReducer(s, { type: "preliminary", id: "request-pre-1", response: pre() });
    expect(s.status).toBe("loading");
    expect(s.preliminary?.recommendations.map((r) => r.place_id)).toEqual([recB.place_id]);
  });

  it("a failure after preliminary keeps the found places with a note instead of an error", () => {
    let s = start(initialRecommendState, "request-pre-1");
    s = recommendReducer(s, { type: "preliminary", id: "request-pre-1", response: pre() });
    s = recommendReducer(s, {
      type: "failure",
      id: "request-pre-1",
      error: { kind: "timeout", message: "Сервер не ответил за 220 секунд.", retryable: true },
    });
    expect(s.status).toBe("success");
    expect(s.error).toBeNull();
    expect(s.response?.recommendations.map((r) => r.place_id)).toEqual([recB.place_id]);
    expect(s.partialNote).toContain("Объяснения ИИ не получены");
  });

  it("the final answer replaces the preliminary one and clears the note", () => {
    let s = start(initialRecommendState, "request-pre-1");
    s = recommendReducer(s, { type: "preliminary", id: "request-pre-1", response: pre() });
    s = recommendReducer(s, { type: "success", id: "request-pre-1", response: okResponse("request-pre-1") });
    expect(s.preliminary).toBeNull();
    expect(s.partialNote).toBeNull();
    expect(s.response?.mode).toBe("live_rag");
  });

  it("a new request drops the previous preliminary answer", () => {
    let s = start(initialRecommendState, "request-pre-1");
    s = recommendReducer(s, { type: "preliminary", id: "request-pre-1", response: pre() });
    s = start(s, "request-pre-2");
    expect(s.preliminary).toBeNull();
  });
});
