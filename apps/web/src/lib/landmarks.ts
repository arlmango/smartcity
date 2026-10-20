/**
 * Lightweight landmark models drawn with fill-extrusion slices (MapLibre extrudes only flat-topped
 * prisms, so a sphere is a stack of discs whose radius follows the circle profile — never a cylinder).
 *
 * Every number below comes from the OSM objects named in `osm` (centre and footprint diameter measured
 * on the OSM outline in the Protomaps tiles of 19.10.2026; heights from OSM levels × 3.2 m or `height`).
 * Where OSM has no shape (Baiterek's trunk and crown, Nur Alem's stem) the model is an explicit,
 * simplified stylisation and is labelled so on the map. Not exact models, not photogrammetry.
 */
import type { Feature, FeatureCollection, Polygon } from "geojson";

export interface LandmarkModel {
  key: string;
  label: string; // shown on the map
  centre: [number, number]; // [lon, lat]
  /** OSM objects replaced by the model (hidden in both building sources). */
  osm: { type: "w" | "r"; id: number }[];
  sources: string[];
}

const LEVEL_M = 3.2; // the project's height per OSM level (same as the building tiles)

export const BAITEREK: LandmarkModel = {
  key: "baiterek",
  label: "Байтерек · стилизация",
  centre: [71.430456, 51.128287],
  osm: [{ type: "w", id: 230401644 }, { type: "w", id: 230401645 }],
  sources: [
    "OSM way/230401644 «Байтерек»: building:part, roof:shape=orb, building:levels=30, building:colour=#C3B391; контур ≈ 21,9 м",
    "OSM way/230401645 «Бәйтерек»: historic=monument, building:levels=27, Wikidata Q804210",
    "Ствол и «крона» — упрощённая стилизация: в OSM их форма не размечена",
  ],
};

export const NUR_ALEM: LandmarkModel = {
  key: "nur-alem",
  label: "Нур Алем · стилизация",
  centre: [71.416154, 51.089314],
  osm: [{ type: "w", id: 1461813334 }, { type: "w", id: 454857501 }],
  sources: [
    "OSM way/1461813334: building:part, height=100, круглый контур ≈ 78 м (проверено в config/landmark_shapes.json)",
    "OSM way/454857501: контур здания с частями (museum=future); подиум way/1461813335 (6 м) остаётся из OSM",
    "Опора под сферой и полосы остекления — стилизация",
  ],
};

export const LANDMARKS = [BAITEREK, NUR_ALEM];

/** Feature ids of the replaced objects in the Protomaps base tiles (v4 encodes ways as 2^45 + id). */
export const PROTOMAPS_WAY_OFFSET = 2 ** 45;
export const hiddenBaseIds = (models = LANDMARKS): number[] =>
  models.flatMap((m) => m.osm.filter((o) => o.type === "w").map((o) => PROTOMAPS_WAY_OFFSET + o.id));
/** The same objects in SmartCity's own building tiles (`oid` property). */
export const hiddenOwnIds = (models = LANDMARKS): string[] => models.flatMap((m) => m.osm.map((o) => `${o.type}${o.id}`));

// ------------------------------------------------------------------ geometry helpers

const M_PER_DEG_LAT = 110_540;
const mPerDegLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

function circle(centre: [number, number], radiusM: number, segments: number, dx = 0, dy = 0): Polygon {
  const [lon, lat] = centre;
  const ring: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * 2 * Math.PI;
    ring.push([lon + (dx + radiusM * Math.cos(a)) / mPerDegLon(lat), lat + (dy + radiusM * Math.sin(a)) / M_PER_DEG_LAT]);
  }
  return { type: "Polygon", coordinates: [ring] };
}

type Props = { h: number; mh: number; c: string; part: string; lbl?: string };
const piece = (geometry: Polygon, props: Props): Feature<Polygon, Props> => ({ type: "Feature", geometry, properties: props });

/** Slices of a sphere of diameter `d` whose top is at `top`; radius per slice follows the circle. */
export function sphereSlices(centre: [number, number], d: number, top: number, n: number, segments: number,
  colour: (i: number) => string, part: string): Feature<Polygon, Props>[] {
  const r = d / 2;
  const zc = top - r;
  const out: Feature<Polygon, Props>[] = [];
  for (let i = 0; i < n; i++) {
    const z0 = top - d + (d * i) / n;
    const z1 = top - d + (d * (i + 1)) / n;
    const zm = (z0 + z1) / 2 - zc;
    const ri = Math.sqrt(Math.max(0, r * r - zm * zm));
    if (ri < r * 0.08) continue;
    out.push(piece(circle(centre, ri, segments), { h: +z1.toFixed(2), mh: +z0.toFixed(2), c: colour(i), part }));
  }
  return out;
}

export type Detail = "high" | "low";

/** Baiterek: white trunk, ribs flaring into a crown that cradles the orb (OSM colour). */
export function baiterekPieces(detail: Detail = "high"): Feature<Polygon, Props>[] {
  const c = BAITEREK.centre;
  const top = 30 * LEVEL_M; // 96 m: building:levels=30 of the orb part
  const d = 21.9; // orb footprint diameter (OSM outline)
  const orbBase = top - d;
  const white = "#F3F2EC";
  const pieces: Feature<Polygon, Props>[] = [
    piece(circle(c, 7.4, 32), { h: 1.6, mh: 0, c: "#E6E3DA", part: "plinth" }),
    piece(circle(c, 2.6, 16), { h: orbBase + 3, mh: 0, c: white, part: "trunk" }),
  ];
  const ribs = detail === "high" ? 12 : 6;
  const step = detail === "high" ? 2.4 : 4.8;
  const flareFrom = orbBase - 22;
  for (let z = 0; z < orbBase + 6; z += step) {
    // Narrow bundle below the crown, then a smooth flare to just under the orb's equator.
    const t = Math.min(1, Math.max(0, (z - flareFrom) / (orbBase + 6 - flareFrom)));
    const radius = 3.1 + t * t * (d / 2 - 1.2);
    for (let k = 0; k < ribs; k++) {
      const a = (k / ribs) * 2 * Math.PI;
      pieces.push(piece(circle(c, 0.55, 6, radius * Math.cos(a), radius * Math.sin(a)), {
        h: +(z + step).toFixed(2), mh: +z.toFixed(2), c: white, part: "rib",
      }));
    }
  }
  const gold = (i: number) => (i % 4 === 1 ? "#B9A57F" : "#C3B391");
  pieces.push(...sphereSlices(c, d, top, detail === "high" ? 18 : 9, detail === "high" ? 40 : 20, gold, "orb"));
  pieces[pieces.length - 1]!.properties.lbl = BAITEREK.label;
  return pieces;
}

/** Nur Alem: glazed sphere (top at OSM height=100 m, diameter = OSM outline) on a short stem. */
export function nurAlemPieces(detail: Detail = "high"): Feature<Polygon, Props>[] {
  const c = NUR_ALEM.centre;
  const top = 100;
  const d = 78.1;
  const glass = (i: number) => (i % 2 ? "#A9C3D3" : "#C2D6E1");
  const pieces: Feature<Polygon, Props>[] = [piece(circle(c, d * 0.2, 32), { h: top - d + 4, mh: 6, c: "#DDE3E4", part: "stem" })];
  pieces.push(...sphereSlices(c, d, top, detail === "high" ? 28 : 14, detail === "high" ? 64 : 32, glass, "sphere"));
  pieces[pieces.length - 1]!.properties.lbl = NUR_ALEM.label;
  return pieces;
}

export function landmarkModels(detail: Detail = "high"): FeatureCollection<Polygon, Props> {
  return { type: "FeatureCollection", features: [...baiterekPieces(detail), ...nurAlemPieces(detail)] };
}
