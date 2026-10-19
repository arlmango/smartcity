/**
 * Map layers served by GET /api/map/{layer} (docs/CONTRACTS.md §7).
 * Features are validated one by one: a malformed feature is dropped and counted
 * (partial data is shown and reported), a malformed collection is an error.
 */
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { z } from "zod";

export const MAP_LAYERS = ["buildings", "roads", "water", "green", "coverage"] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];

export type HeightSource = "height" | "levels" | "estimate" | "default";

export interface BuildingProps {
  id: string;
  name?: string | null;
  building?: string | null;
  levels?: number | null;
  height_m: number;
  min_height_m: number;
  height_source: HeightSource;
}

export interface LayerResult {
  layer: MapLayer;
  data: FeatureCollection;
  dropped: number;
}

const ALLOWED_GEOMETRY: Record<MapLayer, Geometry["type"][]> = {
  buildings: ["Polygon", "MultiPolygon"],
  roads: ["LineString", "MultiLineString"],
  water: ["Polygon", "MultiPolygon", "LineString", "MultiLineString"],
  green: ["Polygon", "MultiPolygon"],
  coverage: ["Polygon", "MultiPolygon"],
};

const isPosition = (p: unknown): p is Position =>
  Array.isArray(p) &&
  p.length >= 2 &&
  typeof p[0] === "number" &&
  typeof p[1] === "number" &&
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1]) &&
  p[0] >= -180 &&
  p[0] <= 180 &&
  p[1] >= -90 &&
  p[1] <= 90;

const isLine = (l: unknown, min: number): boolean => Array.isArray(l) && l.length >= min && l.every(isPosition);
const isPolygon = (poly: unknown): boolean => Array.isArray(poly) && poly.length >= 1 && poly.every((r) => isLine(r, 4));

export function isValidGeometry(g: unknown, allowed: Geometry["type"][]): g is Geometry {
  if (!g || typeof g !== "object") return false;
  const geom = g as { type?: unknown; coordinates?: unknown };
  if (typeof geom.type !== "string" || !allowed.includes(geom.type as Geometry["type"])) return false;
  const c = geom.coordinates;
  switch (geom.type) {
    case "LineString":
      return isLine(c, 2);
    case "MultiLineString":
      return Array.isArray(c) && c.length > 0 && c.every((l) => isLine(l, 2));
    case "Polygon":
      return isPolygon(c);
    case "MultiPolygon":
      return Array.isArray(c) && c.length > 0 && c.every(isPolygon);
    default:
      return false;
  }
}

const optStr = z.string().nullable().optional();
const BuildingPropsSchema = z.object({
  id: z.string(),
  name: optStr,
  building: optStr,
  levels: z.number().finite().nullable().optional(),
  height_m: z.number().finite().min(0).max(1000),
  min_height_m: z.number().finite().min(0).max(1000).default(0),
  height_source: z.enum(["height", "levels", "estimate", "default"]),
});
const RoadPropsSchema = z.object({ id: z.string(), highway: z.string(), name: optStr });
const KindPropsSchema = z.object({ id: z.string(), kind: z.string(), name: optStr });
const CoveragePropsSchema = z.record(z.string(), z.unknown());

const PROPS: Record<MapLayer, z.ZodTypeAny> = {
  buildings: BuildingPropsSchema,
  roads: RoadPropsSchema,
  water: KindPropsSchema,
  green: KindPropsSchema,
  coverage: CoveragePropsSchema,
};

const CollectionSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(z.unknown()),
});

export class InvalidLayerError extends Error {
  constructor(public readonly layer: MapLayer) {
    super(`Слой карты «${layer}» пришёл в неверном формате`);
  }
}

/** City boundary (GET /api/basemap/boundary): polygon features only; anything else is dropped. */
export function parseBoundary(raw: unknown): FeatureCollection {
  const parsed = CollectionSchema.safeParse(raw);
  if (!parsed.success) throw new Error("invalid boundary");
  const features: Feature[] = [];
  for (const f of parsed.data.features) {
    const feat = f as { type?: unknown; geometry?: unknown };
    if (feat?.type === "Feature" && isValidGeometry(feat.geometry, ["Polygon", "MultiPolygon"])) {
      features.push({ type: "Feature", geometry: feat.geometry, properties: {} });
    }
  }
  return { type: "FeatureCollection", features };
}

export function parseLayer(layer: MapLayer, raw: unknown): LayerResult {
  const parsed = CollectionSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidLayerError(layer);
  const features: Feature[] = [];
  let dropped = 0;
  for (const f of parsed.data.features) {
    const feat = f as { type?: unknown; geometry?: unknown; properties?: unknown };
    if (feat?.type !== "Feature" || !isValidGeometry(feat.geometry, ALLOWED_GEOMETRY[layer])) {
      dropped++;
      continue;
    }
    const props = PROPS[layer].safeParse(feat.properties ?? {});
    if (!props.success) {
      dropped++;
      continue;
    }
    if (layer === "buildings") {
      const p = props.data as BuildingProps;
      if (p.min_height_m > p.height_m) {
        dropped++;
        continue;
      }
    }
    features.push({ type: "Feature", geometry: feat.geometry, properties: props.data });
  }
  return { layer, data: { type: "FeatureCollection", features }, dropped };
}

export interface HeightStats {
  height: number;
  levels: number;
  estimate: number;
  default: number;
}

export function heightStats(buildings: FeatureCollection | undefined): HeightStats {
  const s: HeightStats = { height: 0, levels: 0, estimate: 0, default: 0 };
  for (const f of buildings?.features ?? []) {
    const src = (f.properties as BuildingProps | null)?.height_source;
    if (src === "height" || src === "levels" || src === "estimate" || src === "default") s[src]++;
  }
  return s;
}

/** Ray-casting point-in-polygon for [lon, lat] against Polygon/MultiPolygon features (holes respected). */
export function pointInCoverage(lon: number, lat: number, coverage: FeatureCollection | undefined): boolean | null {
  const feats = coverage?.features ?? [];
  if (feats.length === 0) return null; // unknown coverage: caller decides
  const inRing = (ring: Position[]): boolean => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i] as [number, number];
      const [xj, yj] = ring[j] as [number, number];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const inPoly = (poly: Position[][]): boolean => {
    const [outer, ...holes] = poly;
    if (!outer || !inRing(outer)) return false;
    return !holes.some(inRing);
  };
  return feats.some((f) => {
    const g = f.geometry;
    if (g?.type === "Polygon") return inPoly(g.coordinates);
    if (g?.type === "MultiPolygon") return g.coordinates.some(inPoly);
    return false;
  });
}

/** [minLon, minLat, maxLon, maxLat] of all coordinates of a collection. */
export function collectionBounds(fc: FeatureCollection | undefined): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (c: unknown): void => {
    if (isPosition(c)) {
      const [x, y] = c as [number, number];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    } else if (Array.isArray(c)) c.forEach(visit);
  };
  for (const f of fc?.features ?? []) {
    const g = f.geometry as { coordinates?: unknown } | null;
    visit(g?.coordinates);
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}
