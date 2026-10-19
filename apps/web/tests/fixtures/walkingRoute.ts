import type { WalkingRoute } from "../../src/lib/contracts";
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
