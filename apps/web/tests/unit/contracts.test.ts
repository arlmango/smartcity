import { describe, expect, it } from "vitest";
import {
  CoverageResponseSchema,
  RecommendRequestSchema,
  RecommendResponseSchema,
  ReadyResponseSchema,
} from "@/lib/contracts";
import { coverage, okResponse, readyOk, recA } from "../fixtures/synthetic";

const ID = "test-request-0001";

describe("RecommendResponse validation", () => {
  it("accepts a valid response", () => {
    expect(RecommendResponseSchema.safeParse(okResponse(ID)).success).toBe(true);
  });

  it("rejects more than 3 recommendations", () => {
    const r = okResponse(ID, [recA, { ...recA, place_id: "b" }, { ...recA, place_id: "c" }, { ...recA, place_id: "d" }]);
    expect(RecommendResponseSchema.safeParse(r).success).toBe(false);
  });

  it("rejects duplicate place_id", () => {
    const r = okResponse(ID, [recA, recA]);
    expect(RecommendResponseSchema.safeParse(r).success).toBe(false);
  });

  it("rejects timing.estimated=false (estimates must stay estimates)", () => {
    const bad = okResponse(ID, [{ ...recA, timing: { ...recA.timing, estimated: false as unknown as true } }]);
    expect(RecommendResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects non-finite / out-of-range coordinates", () => {
    const bad = okResponse(ID, [{ ...recA, coordinates: { lat: 200, lon: 71 } }]);
    expect(RecommendResponseSchema.safeParse(bad).success).toBe(false);
    const nan = JSON.parse(JSON.stringify(okResponse(ID)));
    nan.recommendations[0].coordinates.lat = "51.0";
    expect(RecommendResponseSchema.safeParse(nan).success).toBe(false);
  });

  it("rejects unknown status/mode and a non-null route", () => {
    expect(RecommendResponseSchema.safeParse({ ...okResponse(ID), status: "great" }).success).toBe(false);
    expect(RecommendResponseSchema.safeParse({ ...okResponse(ID), mode: "magic" }).success).toBe(false);
    expect(RecommendResponseSchema.safeParse({ ...okResponse(ID), route: { type: "LineString" } }).success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const r = JSON.parse(JSON.stringify(okResponse(ID)));
    delete r.recommendations[0].source;
    expect(RecommendResponseSchema.safeParse(r).success).toBe(false);
  });

  it("rejects naive datetimes (no timezone)", () => {
    const r = okResponse(ID, [{ ...recA, as_of: "2026-10-01T00:00:00" }]);
    expect(RecommendResponseSchema.safeParse(r).success).toBe(false);
  });
});

describe("other responses", () => {
  it("ready and coverage fixtures validate", () => {
    expect(ReadyResponseSchema.safeParse(readyOk).success).toBe(true);
    expect(CoverageResponseSchema.safeParse(coverage).success).toBe(true);
  });
  it("coverage with bad bbox is rejected", () => {
    expect(CoverageResponseSchema.safeParse({ ...coverage, bbox: [1, 2, 3] }).success).toBe(false);
  });
});

describe("RecommendRequest", () => {
  const base = {
    origin: { lat: 51.09, lon: 71.414 },
    time_budget_min: 40,
    constraints: {},
    client_request_id: ID,
  };
  it("fills defaults and is strict", () => {
    const r = RecommendRequestSchema.parse(base);
    expect(r.travel_mode).toBe("walking");
    expect(r.constraints.required_features).toEqual([]);
    expect(RecommendRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
  it("enforces budget range, query length and id pattern", () => {
    expect(RecommendRequestSchema.safeParse({ ...base, time_budget_min: 5 }).success).toBe(false);
    expect(RecommendRequestSchema.safeParse({ ...base, time_budget_min: 181 }).success).toBe(false);
    expect(RecommendRequestSchema.safeParse({ ...base, query: "я".repeat(2001) }).success).toBe(false);
    expect(RecommendRequestSchema.safeParse({ ...base, client_request_id: "bad id!" }).success).toBe(false);
  });
});
