import type { WalkingRoute, WalkPlan } from "../../src/lib/contracts";
/** SYNTHETIC bent network for UI tests only; not an asserted real pedestrian route. */
export const walkingRoute: WalkingRoute = {
  provider: "valhalla", graph_version: "SYNTHETIC-test-graph", note: "SYNTHETIC. Последний участок и доступность не проверены.",
  outbound: {
    geometry: { type: "LineString", coordinates: [[71.414, 51.089], [71.414, 51.090], [71.415, 51.090], [71.416, 51.0894]] },
    distance_m: 310, duration_s: 250, start_snap_m: 5, end_snap_m: 18, access_estimate_min: 1,
  },
  return_leg: {
    geometry: { type: "LineString", coordinates: [[71.416, 51.0894], [71.415, 51.090], [71.414, 51.090], [71.414, 51.089]] },
    distance_m: 310, duration_s: 250, start_snap_m: 18, end_snap_m: 5, access_estimate_min: 1,
  },
};

const leg = (coordinates: [number, number][], distance_m: number, duration_s: number) => ({
  geometry: { type: "LineString" as const, coordinates }, distance_m, duration_s, start_snap_m: 4, end_snap_m: 9, access_estimate_min: 0,
});
/** SYNTHETIC timebox plan (cafe -> playground -> start) with bent legs; totals add up: 12 + 40 + 5 = 57. */
export const walkPlan: WalkPlan = {
  stops: [
    { place_id: "synthetic-cafe-1", name: "SYNTHETIC Кафе «Тест»", name_is_generic: false, category: "cafe", category_label: "Кафе",
      coordinates: { lat: 51.0895, lon: 71.4165 }, arrive_min: 4, visit_min: 25, opening_status: "open",
      leg_in: leg([[71.414, 51.089], [71.415, 51.0891], [71.4164, 51.0894]], 220, 200) },
    { place_id: "synthetic-playground-2", name: "Детская площадка", name_is_generic: true, category: "playground", category_label: "Детская площадка",
      coordinates: { lat: 51.088, lon: 71.412 }, arrive_min: 34, visit_min: 15, opening_status: "unknown",
      leg_in: leg([[71.4164, 51.0894], [71.414, 51.0885], [71.4121, 51.0881]], 330, 290) },
  ],
  return_leg: leg([[71.4121, 51.0881], [71.413, 51.0886], [71.414, 51.089]], 160, 150),
  graph_version: "SYNTHETIC-test-graph", time_budget_min: 60, walk_min: 12, visit_min: 40, buffer_min: 5, total_min: 57,
  distance_m: 710, returns_to_start: true,
  why: ["SYNTHETIC: лучшие совпадения, которые помещаются в 60 мин."],
  skipped: [{ place_id: "synthetic-museum-3", name: "SYNTHETIC Музей тестов", reason: "Не помещается в 60 мин вместе с другими остановками" }],
  method: "SYNTHETIC method",
};
