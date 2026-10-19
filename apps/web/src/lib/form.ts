/**
 * Walk form state and request building. The form keeps a full `Constraints`
 * object, so quick refinements ("Поближе", "Без кафе", ...) and server
 * relaxations only change one field and keep all earlier hard conditions.
 */
import {
  EMPTY_CONSTRAINTS,
  RecommendRequestSchema,
  type Category,
  type Constraints,
  type ConversationTurn,
  type Feature,
  type Interest,
  type RecommendRequest,
  type Recommendation,
} from "./contracts";
import { QUERY_MAX, TIME_MAX, TIME_MIN } from "./labels";
import { almatyInputToIso, checkStart } from "./time";

export type OriginKind = "map" | "gps" | "demo" | "search" | "center";

export interface Origin {
  lat: number;
  lon: number;
  kind: OriginKind;
  label: string;
}

export interface WalkForm {
  origin: Origin | null;
  query: string;
  interests: Interest[];
  timeBudget: number;
  returnToStart: boolean;
  constraints: Constraints;
  /** null = start now (start_time not sent); otherwise Astana wall-clock "YYYY-MM-DDTHH:mm". */
  startTime: string | null;
}

export const initialForm: WalkForm = {
  origin: null,
  query: "",
  interests: [],
  timeBudget: 40,
  returnToStart: true,
  constraints: EMPTY_CONSTRAINTS,
  startTime: null,
};

export const clampBudget = (n: number): number => Math.min(TIME_MAX, Math.max(TIME_MIN, Math.round(n)));

export function toggle<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

export type FormProblem = "no_origin" | "bad_budget" | "query_too_long" | "bad_start";

export function validateForm(form: WalkForm): FormProblem[] {
  const problems: FormProblem[] = [];
  if (!form.origin) problems.push("no_origin");
  if (!Number.isInteger(form.timeBudget) || form.timeBudget < TIME_MIN || form.timeBudget > TIME_MAX) problems.push("bad_budget");
  if (form.query.length > QUERY_MAX) problems.push("query_too_long");
  if (form.startTime !== null && checkStart(form.startTime) !== null) problems.push("bad_start");
  return problems;
}

export function buildRequest(form: WalkForm, id: string, context: ConversationTurn[]): RecommendRequest {
  if (!form.origin) throw new Error("origin is required");
  return RecommendRequestSchema.parse({
    origin: { lat: form.origin.lat, lon: form.origin.lon },
    query: form.query.trim(),
    time_budget_min: form.timeBudget,
    return_to_start: form.returnToStart,
    travel_mode: "walking",
    interests: form.interests,
    constraints: form.constraints,
    conversation_context: context.slice(-6),
    start_time: form.startTime ? almatyInputToIso(form.startTime) : null,
    client_request_id: id,
  });
}

// ------------------------------------------------------------- hard-condition helpers

export const FOOD_CATEGORIES: Category[] = ["cafe", "food"];

export function withRequiredFeature(c: Constraints, f: Feature, on: boolean): Constraints {
  const has = c.required_features.includes(f);
  if (on === has) return c;
  return { ...c, required_features: on ? [...c.required_features, f] : c.required_features.filter((x) => x !== f) };
}

export function withExcludedCategories(c: Constraints, cats: Category[], on: boolean): Constraints {
  const exclude = on
    ? Array.from(new Set([...c.exclude_categories, ...cats]))
    : c.exclude_categories.filter((x) => !cats.includes(x));
  const include = on ? c.include_categories.filter((x) => !cats.includes(x)) : c.include_categories;
  return { ...c, exclude_categories: exclude, include_categories: include };
}

export const excludesAll = (c: Constraints, cats: Category[]): boolean => cats.every((x) => c.exclude_categories.includes(x));

// ------------------------------------------------------------- quick refinements

export type RefinementKind = "closer" | "no_cafe" | "indoor_only" | "other_options";

export const REFINEMENT_LABEL: Record<RefinementKind, string> = {
  closer: "Поближе",
  no_cafe: "Без кафе",
  indoor_only: "Только внутри",
  other_options: "Другие варианты",
};

/** "Поближе": cap distance at ~70% of the farthest shown (or previous cap), min 100 m. */
export function closerDistance(c: Constraints, recs: Recommendation[]): number {
  const farthest = recs.reduce((m, r) => Math.max(m, r.distance.meters), 0);
  const base = c.max_distance_m ?? (farthest > 0 ? farthest : 1000);
  const next = Math.floor((Math.min(base, farthest || base) * 0.7) / 50) * 50;
  return Math.min(10000, Math.max(100, next));
}

export function refineConstraints(kind: RefinementKind, c: Constraints, recs: Recommendation[]): Constraints {
  switch (kind) {
    case "closer":
      return { ...c, max_distance_m: closerDistance(c, recs) };
    case "no_cafe":
      return withExcludedCategories(c, ["cafe"], true);
    case "indoor_only":
      return withRequiredFeature(c, "indoor", true);
    case "other_options": {
      const ids = Array.from(new Set([...c.exclude_place_ids, ...recs.map((r) => r.place_id)]));
      return { ...c, exclude_place_ids: ids.slice(-20) };
    }
  }
}

/** A refinement is pointless if it would not change the constraints (e.g. "Поближе" at 100 m). */
export function refinementChanges(kind: RefinementKind, c: Constraints, recs: Recommendation[]): boolean {
  return JSON.stringify(refineConstraints(kind, c, recs)) !== JSON.stringify(c);
}
