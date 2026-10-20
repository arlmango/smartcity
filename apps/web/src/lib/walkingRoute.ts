import type { FeatureCollection, LineString } from "geojson";
import type { WalkingRoute, WalkPlan } from "./contracts";

/** What the map draws: router legs only, plus labelled points where each leg meets the network. */
export interface MapRoute {
  kind: "single" | "plan";
  legs: { leg: "outbound" | "return"; geometry: LineString }[];
  marks: { letter: string; label: string; point: [number, number] }[];
  hasReturn: boolean;
}

const last = (g: LineString) => g.coordinates[g.coordinates.length - 1] as [number, number];

export function mapRouteOf(route: WalkingRoute | null): MapRoute | null {
  if (!route) return null;
  const out = route.outbound.geometry as LineString;
  return {
    kind: "single",
    legs: [
      { leg: "outbound", geometry: out },
      ...(route.return_leg ? [{ leg: "return" as const, geometry: route.return_leg.geometry as LineString }] : []),
    ],
    marks: [
      { letter: "А", label: "Начало пути на дорожной сети", point: out.coordinates[0] as [number, number] },
      { letter: "Б", label: "Конец пути на дорожной сети", point: last(out) },
    ],
    hasReturn: !!route.return_leg,
  };
}

/** Timebox plan: each stop's incoming leg, then the way back; marks are numbered stops. */
export function mapRouteOfPlan(plan: WalkPlan): MapRoute {
  return {
    kind: "plan",
    legs: [
      ...plan.stops.map((s) => ({ leg: "outbound" as const, geometry: s.leg_in.geometry as LineString })),
      ...(plan.return_leg ? [{ leg: "return" as const, geometry: plan.return_leg.geometry as LineString }] : []),
    ],
    marks: plan.stops.map((s, i) => ({
      letter: String(i + 1),
      label: `Остановка ${i + 1}: ${s.name} (конец пути на дорожной сети)`,
      point: last(s.leg_in.geometry as LineString),
    })),
    hasReturn: !!plan.return_leg,
  };
}

/** Only the router's network geometry. Never join origin/POI snap gaps. */
export function routeFeatures(route: MapRoute | WalkingRoute | null): FeatureCollection<LineString> {
  const r = route && "legs" in route ? route : mapRouteOf(route);
  if (!r) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: r.legs.map(({ leg, geometry }) => ({ type: "Feature" as const, properties: { leg }, geometry })),
  };
}

export function routeCoordinates(route: MapRoute | WalkingRoute | null): [number, number][] {
  return routeFeatures(route).features.flatMap((f) => f.geometry.coordinates as [number, number][]);
}
