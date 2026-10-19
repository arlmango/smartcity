import { describe, expect, it } from "vitest";
import { WalkingRouteSchema, RecommendationSchema } from "@/lib/contracts";
import { routeFeatures, routeCoordinates } from "@/lib/walkingRoute";
import { walkingRoute } from "../fixtures/walkingRoute";
import { recA } from "../fixtures/synthetic";

describe("walking network geometry boundary", () => {
  it("accepts bent legs and preserves their separate directions without gap connectors", () => {
    const route = WalkingRouteSchema.parse(walkingRoute);
    const features = routeFeatures(route);
    expect(features.features.map((f) => f.properties?.leg)).toEqual(["outbound", "return"]);
    expect(features.features[0]?.geometry).toEqual(route.outbound.geometry);
    expect(routeCoordinates(route)).toHaveLength(8);
  });
  it("does not fabricate a return or route when absent", () => {
    expect(routeFeatures(null).features).toEqual([]);
    expect(routeFeatures({ ...walkingRoute, return_leg: null }).features).toHaveLength(1);
    const { route: _route, ...oldRecommendation } = recA;
    expect(RecommendationSchema.parse(oldRecommendation).route).toBeNull();
  });
  it.each([[], [[71, 51]], [[181, 51], [71, 51]], [[71, Infinity], [71, 51]], [[71, 51, 5], [71, 51]]].map((coordinates) => ({ coordinates })))("rejects malformed coordinates $coordinates", ({ coordinates }) => {
    expect(WalkingRouteSchema.safeParse({ ...walkingRoute, outbound: { ...walkingRoute.outbound, geometry: { type: "LineString", coordinates } } }).success).toBe(false);
  });
  it("rejects false provider, negative metrics and wrong geometry", () => {
    expect(WalkingRouteSchema.safeParse({ ...walkingRoute, provider: "straight-line" }).success).toBe(false);
    expect(WalkingRouteSchema.safeParse({ ...walkingRoute, outbound: { ...walkingRoute.outbound, distance_m: -1 } }).success).toBe(false);
    expect(WalkingRouteSchema.safeParse({ ...walkingRoute, outbound: { ...walkingRoute.outbound, geometry: { type: "Polygon", coordinates: [] } } }).success).toBe(false);
  });
});
