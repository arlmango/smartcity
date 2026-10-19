import { describe, expect, it } from "vitest";
import { EMPTY_CONSTRAINTS } from "@/lib/contracts";
import {
  buildRequest,
  clampBudget,
  closerDistance,
  initialForm,
  refineConstraints,
  refinementChanges,
  validateForm,
  withExcludedCategories,
  withRequiredFeature,
} from "@/lib/form";
import { recA, recB, recC } from "../fixtures/synthetic";

const origin = { lat: 51.089, lon: 71.414, kind: "demo" as const, label: "demo" };

describe("form validation & request", () => {
  it("requires an origin and a budget in 10..180", () => {
    expect(validateForm(initialForm)).toContain("no_origin");
    expect(validateForm({ ...initialForm, origin, timeBudget: 5 })).toContain("bad_budget");
    expect(validateForm({ ...initialForm, origin })).toEqual([]);
    expect(clampBudget(500)).toBe(180);
    expect(clampBudget(1)).toBe(10);
  });

  it("builds a contract-valid request (walking only, ui constraints)", () => {
    const form = {
      ...initialForm,
      origin,
      query: "  кофе  ",
      interests: ["coffee" as const],
      constraints: withRequiredFeature(EMPTY_CONSTRAINTS, "socket", true),
    };
    const r = buildRequest(form, "abcdefgh-1234", [{ role: "user", text: "x" }]);
    expect(r.query).toBe("кофе");
    expect(r.travel_mode).toBe("walking");
    expect(r.constraints.required_features).toEqual(["socket"]);
    expect(r.conversation_context).toHaveLength(1);
    expect(r.origin).toEqual({ lat: 51.089, lon: 71.414 });
  });
});

describe("quick refinements keep earlier hard conditions", () => {
  const base = withExcludedCategories(withRequiredFeature(EMPTY_CONSTRAINTS, "wifi", true), ["food"], true);
  const recs = [recA, recB, recC];

  it("Поближе caps distance below the farthest result", () => {
    const c = refineConstraints("closer", base, recs);
    expect(c.max_distance_m).toBe(closerDistance(base, recs));
    expect(c.max_distance_m!).toBeLessThan(610);
    expect(c.max_distance_m!).toBeGreaterThanOrEqual(100);
    expect(c.required_features).toEqual(["wifi"]);
    expect(c.exclude_categories).toEqual(["food"]);
  });

  it("Поближе shrinks further each time and stops at 100 m", () => {
    let c = refineConstraints("closer", base, recs);
    for (let i = 0; i < 20; i++) c = refineConstraints("closer", c, recs);
    expect(c.max_distance_m).toBe(100);
    expect(refinementChanges("closer", c, recs)).toBe(false);
  });

  it("Без кафе excludes cafe and keeps the rest", () => {
    const c = refineConstraints("no_cafe", base, recs);
    expect(c.exclude_categories.sort()).toEqual(["cafe", "food"]);
    expect(c.required_features).toEqual(["wifi"]);
  });

  it("Только внутри requires indoor", () => {
    const c = refineConstraints("indoor_only", base, recs);
    expect(c.required_features.sort()).toEqual(["indoor", "wifi"]);
  });

  it("Другие варианты excludes shown ids (≤20)", () => {
    const c = refineConstraints("other_options", base, recs);
    expect(c.exclude_place_ids).toEqual(recs.map((r) => r.place_id));
    const many = { ...base, exclude_place_ids: Array.from({ length: 20 }, (_, i) => `p${i}`) };
    expect(refineConstraints("other_options", many, recs).exclude_place_ids).toHaveLength(20);
  });
});
