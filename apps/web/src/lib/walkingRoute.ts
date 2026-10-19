import type { FeatureCollection, LineString } from "geojson";
import type { WalkingRoute } from "./contracts";

/** Only the router's network geometry. Never join origin/POI snap gaps. */
export function routeFeatures(route: WalkingRoute | null): FeatureCollection<LineString> {
  if (!route) return { type: "FeatureCollection", features: [] };
  const legs = [["outbound", route.outbound], ["return", route.return_leg]] as const;
  return {
    type: "FeatureCollection",
    features: legs.flatMap(([leg, data]) => data ? [{
      type: "Feature" as const, properties: { leg }, geometry: data.geometry,
    }] : []),
  };
}

export function routeCoordinates(route: WalkingRoute | null): [number, number][] {
  return routeFeatures(route).features.flatMap((f) => f.geometry.coordinates as [number, number][]);
}
