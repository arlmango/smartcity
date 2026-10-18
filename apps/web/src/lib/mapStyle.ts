/**
 * MapLibre style assembled in code from SmartCity's own GeoJSON layers (/api/map/*).
 * No external tiles, no keys. Glyphs are self-hosted PBFs generated from Manrope
 * (OFL-1.1) by scripts/generate-glyphs.mjs into public/fonts/.
 */
import type {
  ExpressionSpecification,
  LayerSpecification,
  StyleSpecification,
} from "maplibre-gl";

export type ViewMode = "3d" | "2d";

export const INITIAL_VIEW = {
  center: [71.414, 51.089] as [number, number], // EXPO / MEGA Silk Way area, never the user's position
  zoom: 15,
  pitch3d: 50,
  bearing: -12,
};
export const PITCH_3D = 55;
export const MAP_FONT = "Manrope-Regular";

export const COLORS = {
  background: "#EEF0EA",
  green: "#D3E5C3",
  greenOutline: "#BCD3A9",
  water: "#B7D4E2",
  roadCasing: "#D3D9D0",
  road: "#FFFFFF",
  roadMajor: "#FBFCF8",
  label: "#3D4741",
  labelHalo: "#F6F7F2",
  buildingHeight: "#C3CABF",
  buildingLevels: "#CDD3C9",
  buildingDefault: "#DCE0D7",
  buildingOutline: "#B5BDB1",
  coverage: "#17201C",
};

export const SOURCE_IDS = ["green", "water", "roads", "buildings", "coverage"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/** Layers shown only in one view mode. */
export const LAYERS_3D = ["buildings-3d", "buildings-3d-default"] as const;
export const LAYERS_2D = ["buildings-2d", "buildings-2d-outline"] as const;

const EMPTY = { type: "FeatureCollection", features: [] } as const;

/** Road width by OSM highway class, interpolated by zoom. */
export function roadWidth(casing: boolean): ExpressionSpecification {
  const extra = casing ? 2 : 0;
  const cls: ExpressionSpecification = [
    "match",
    ["get", "highway"],
    ["motorway", "trunk", "primary"],
    6,
    ["secondary", "tertiary"],
    4.5,
    ["residential", "unclassified", "living_street", "service"],
    2.5,
    ["pedestrian", "footway", "path", "cycleway", "steps"],
    1.2,
    2,
  ];
  return [
    "interpolate",
    ["exponential", 1.6],
    ["zoom"],
    12,
    ["+", ["*", cls, 0.35], extra * 0.5],
    15,
    ["+", cls, extra],
    18,
    ["+", ["*", cls, 3.2], extra * 1.5],
  ];
}

const IS_PATH: ExpressionSpecification = ["match", ["get", "highway"], ["footway", "path", "cycleway", "steps", "pedestrian"], true, false];

export function buildMapStyle(opts: { glyphsUrl: string; mode: ViewMode }): StyleSpecification {
  const show3d = opts.mode === "3d" ? "visible" : "none";
  const show2d = opts.mode === "2d" ? "visible" : "none";
  const layers: LayerSpecification[] = [
    { id: "background", type: "background", paint: { "background-color": COLORS.background } },
    {
      id: "green-fill",
      type: "fill",
      source: "green",
      paint: { "fill-color": COLORS.green, "fill-outline-color": COLORS.greenOutline },
    },
    {
      id: "water-fill",
      type: "fill",
      source: "water",
      filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
      paint: { "fill-color": COLORS.water },
    },
    {
      id: "water-line",
      type: "line",
      source: "water",
      filter: ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]],
      paint: { "line-color": COLORS.water, "line-width": ["interpolate", ["linear"], ["zoom"], 13, 1, 18, 6] },
    },
    {
      id: "roads-casing",
      type: "line",
      source: "roads",
      filter: ["!", IS_PATH],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": COLORS.roadCasing, "line-width": roadWidth(true) },
    },
    {
      id: "roads-paths",
      type: "line",
      source: "roads",
      filter: IS_PATH,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#FFFFFF", "line-width": roadWidth(false), "line-opacity": 0.9 },
    },
    {
      id: "roads",
      type: "line",
      source: "roads",
      filter: ["!", IS_PATH],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": COLORS.road, "line-width": roadWidth(false) },
    },
    // ---- buildings, 2D (flat fills + outline)
    {
      id: "buildings-2d",
      type: "fill",
      source: "buildings",
      layout: { visibility: show2d },
      paint: {
        "fill-color": [
          "match",
          ["get", "height_source"],
          "height",
          COLORS.buildingHeight,
          "levels",
          COLORS.buildingLevels,
          COLORS.buildingDefault,
        ],
        "fill-opacity": ["match", ["get", "height_source"], "default", 0.7, 0.95],
      },
    },
    {
      id: "buildings-2d-outline",
      type: "line",
      source: "buildings",
      layout: { visibility: show2d },
      paint: {
        "line-color": COLORS.buildingOutline,
        "line-width": 0.8,
        "line-dasharray": ["match", ["get", "height_source"], "default", ["literal", [2, 1.5]], ["literal", [1, 0]]],
      },
    },
    // ---- buildings, 3D. fill-extrusion-opacity is not data-driven: approximate (default) heights
    // get their own, more transparent layer so they read visibly as "условно".
    {
      id: "buildings-3d",
      type: "fill-extrusion",
      source: "buildings",
      filter: ["!=", ["get", "height_source"], "default"],
      layout: { visibility: show3d },
      paint: {
        "fill-extrusion-color": ["match", ["get", "height_source"], "height", COLORS.buildingHeight, COLORS.buildingLevels],
        "fill-extrusion-height": ["get", "height_m"],
        "fill-extrusion-base": ["coalesce", ["get", "min_height_m"], 0],
        "fill-extrusion-opacity": 0.92,
        "fill-extrusion-vertical-gradient": true,
      },
    },
    {
      id: "buildings-3d-default",
      type: "fill-extrusion",
      source: "buildings",
      filter: ["==", ["get", "height_source"], "default"],
      layout: { visibility: show3d },
      paint: {
        "fill-extrusion-color": COLORS.buildingDefault,
        "fill-extrusion-height": ["get", "height_m"],
        "fill-extrusion-base": ["coalesce", ["get", "min_height_m"], 0],
        "fill-extrusion-opacity": 0.6,
      },
    },
    {
      id: "coverage-line",
      type: "line",
      source: "coverage",
      paint: { "line-color": COLORS.coverage, "line-width": 1.5, "line-opacity": 0.55, "line-dasharray": [3, 2] },
    },
    {
      id: "road-labels",
      type: "symbol",
      source: "roads",
      minzoom: 14,
      filter: ["all", ["has", "name"], ["!=", ["get", "name"], ""], ["!", IS_PATH]],
      layout: {
        "symbol-placement": "line",
        "text-field": ["get", "name"],
        "text-font": [MAP_FONT],
        "text-size": ["interpolate", ["linear"], ["zoom"], 14, 10, 18, 14],
        "text-max-angle": 30,
        "symbol-spacing": 320,
      },
      paint: { "text-color": COLORS.label, "text-halo-color": COLORS.labelHalo, "text-halo-width": 1.5 },
    },
    {
      id: "green-labels",
      type: "symbol",
      source: "green",
      minzoom: 15,
      filter: ["all", ["has", "name"], ["!=", ["get", "name"], ""], ["in", ["get", "kind"], ["literal", ["park", "garden"]]]],
      layout: {
        "text-field": ["get", "name"],
        "text-font": [MAP_FONT],
        "text-size": 11,
        "text-max-width": 8,
      },
      paint: { "text-color": "#2E5A23", "text-halo-color": COLORS.labelHalo, "text-halo-width": 1.5 },
    },
  ];

  return {
    version: 8,
    name: "SmartCity Astana (own OSM layers)",
    glyphs: opts.glyphsUrl,
    sources: Object.fromEntries(
      SOURCE_IDS.map((id) => [id, { type: "geojson", data: EMPTY as unknown as GeoJSON.FeatureCollection, attribution: "" }]),
    ),
    layers,
  } as StyleSpecification;
}

/** Visibility changes needed to switch the building presentation. */
export function viewModeVisibility(mode: ViewMode): Array<[string, "visible" | "none"]> {
  return [
    ...LAYERS_3D.map((id) => [id, mode === "3d" ? "visible" : "none"] as [string, "visible" | "none"]),
    ...LAYERS_2D.map((id) => [id, mode === "2d" ? "visible" : "none"] as [string, "visible" | "none"]),
  ];
}

export const pitchFor = (mode: ViewMode): number => (mode === "3d" ? PITCH_3D : 0);

export const OSM_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>';
