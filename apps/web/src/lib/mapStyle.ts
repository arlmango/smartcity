/**
 * MapLibre style for the whole of Astana, assembled in code (docs/FRONTEND.md "Карта").
 *
 * Sources:
 * - `base`: Protomaps basemap vector tiles (OSM, ODbL) — roads, water, landuse, labels — served
 *   same-origin by /api/tiles/base/{z}/{x}/{y} from a local PMTiles extract (only the visible area).
 * - `buildings`: SmartCity's own building tiles (/api/tiles/buildings): height + height source,
 *   approximated tagged roof shapes (`rs` slices) and checked landmark stylisations (`styl`).
 * - `coverage`: the recommendation database area (much smaller than the map).
 * - `boundary`: Astana's administrative boundary from OSM (what the map coverage is checked against).
 * - `satellite` (hybrid only, when the API allows it): EOxCloudless 10 m/px ground imagery, faded out
 *   on approach. Never used as a wall texture: buildings stay stylised volumes.
 * Glyphs are self-hosted PBFs generated from Manrope (OFL-1.1) by scripts/generate-glyphs.mjs.
 */
import type { ExpressionSpecification, LayerSpecification, SourceSpecification, StyleSpecification } from "maplibre-gl";

export type ViewMode = "3d" | "2d";
export type BasemapVariant = "hybrid" | "scheme";
export const BASEMAP_LABEL: Record<BasemapVariant, string> = { hybrid: "Гибрид", scheme: "Схема" };

export interface SatelliteSource {
  tiles: string[];
  maxzoom: number;
  attribution: string;
}

/** Tile extent of the base map (lon/lat), checked to contain Astana's administrative boundary. */
export const CITY_BOUNDS: [number, number, number, number] = [71.15, 50.83, 71.85, 51.38];

export const INITIAL_VIEW = {
  center: [71.414, 51.089] as [number, number], // EXPO / MEGA Silk Way area, never the user's position
  zoom: 15,
  pitch3d: 55,
  bearing: -12,
};
export const PITCH_3D = 55;
export const MAP_FONT = "Manrope-Regular";
const FONT_SEMI = "Manrope-SemiBold";
const FONT_BOLD = "Manrope-Bold";

/** Zoom range of the hybrid crossfade: satellite context below, the crisp schematic map above. */
export const HYBRID_FADE: [number, number] = [14.5, 16];

export const COLORS = {
  background: "#EFEEE7",
  green: "#D2E3BF",
  greenOutline: "#BCD3A9",
  water: "#A8CDE0",
  roadCasing: "#D6D4CA",
  road: "#FFFFFF",
  label: "#3A443E",
  labelHalo: "#F7F6F1",
  // Building swatches (also used by the legend and the no-WebGL fallback map).
  buildingHeight: "#D8DFE2",
  buildingLevels: "#E4E7E6",
  buildingEstimate: "#EEEDE8",
  buildingDefault: "#F2F0EA",
  buildingOutline: "#AEB6AB",
  roof: "#FAF9F6",
  coverage: "#17201C",
  coverageAccent: "#9BC53D",
  boundary: "#7A5BA8",
};

/** GeoJSON sources whose data the app sets at runtime. */
export const SOURCE_IDS = ["coverage", "boundary"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/** Layers shown only in one view mode. */
export const LAYERS_3D = ["buildings-3d", "buildings-3d-approx", "buildings-roof"] as const;
export const LAYERS_2D = ["buildings-2d", "buildings-2d-outline"] as const;

const EMPTY = { type: "FeatureCollection", features: [] } as const;

type Value = number | string | ExpressionSpecification;
/**
 * Paint value per variant: hybrid shows satellite-friendly values at city scale and crossfades to the
 * schematic ones on approach. Only for interpolatable values (numbers, colours) that are not zoom
 * expressions themselves. Typed as an expression so it fits number and colour properties alike.
 */
function pick(hybrid: boolean, sat: Value, scheme: Value): ExpressionSpecification {
  if (!hybrid) return scheme as ExpressionSpecification;
  return ["interpolate", ["linear"], ["zoom"], HYBRID_FADE[0], sat, HYBRID_FADE[1], scheme] as ExpressionSpecification;
}

const NAME: ExpressionSpecification = ["coalesce", ["get", "name:ru"], ["get", "name"]];
const kindIn = (...kinds: string[]): ExpressionSpecification => ["in", ["get", "kind"], ["literal", kinds]];
const detailIn = (...kinds: string[]): ExpressionSpecification => ["in", ["get", "kind_detail"], ["literal", kinds]];
const isPoly: ExpressionSpecification = ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]];
const isLine: ExpressionSpecification = ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]];

/** Road width (px) by Protomaps kind / kind_detail, interpolated by zoom. */
export function roadWidth(casing: boolean): ExpressionSpecification {
  const extra = casing ? 1.6 : 0;
  const cls: ExpressionSpecification = [
    "case",
    ["==", ["get", "kind"], "highway"],
    7,
    detailIn("trunk", "primary"),
    6,
    detailIn("secondary"),
    5,
    detailIn("tertiary"),
    4,
    detailIn("trunk_link", "primary_link", "secondary_link", "tertiary_link", "motorway_link"),
    2.6,
    ["==", ["get", "kind"], "minor_road"],
    ["match", ["get", "kind_detail"], "service", 1.6, 2.6],
    ["==", ["get", "kind"], "other"],
    2.2,
    1,
  ];
  return [
    "interpolate",
    ["exponential", 1.7],
    ["zoom"],
    10,
    ["+", ["*", cls, 0.18], extra * 0.3],
    14,
    ["+", ["*", cls, 0.75], extra * 0.8],
    16,
    ["+", ["*", cls, 1.8], extra],
    19,
    ["+", ["*", cls, 6], extra * 1.6],
  ];
}

const ROAD_MIN_ZOOM: ExpressionSpecification = [
  "case",
  ["==", ["get", "kind"], "highway"],
  0,
  detailIn("trunk", "primary", "secondary"),
  0,
  detailIn("tertiary", "trunk_link", "primary_link", "secondary_link", "tertiary_link", "motorway_link"),
  11,
  ["==", ["get", "kind"], "minor_road"],
  ["match", ["get", "kind_detail"], "service", 14, 12.5],
  14,
];
const roadVisible: ExpressionSpecification = [">=", ["zoom"], ROAD_MIN_ZOOM];
const isCarRoad: ExpressionSpecification = ["all", kindIn("highway", "major_road", "minor_road", "other"), roadVisible];
const isPath: ExpressionSpecification = ["==", ["get", "kind"], "path"];
const notTunnel: ExpressionSpecification = ["!=", ["get", "is_tunnel"], true];

// ------------------------------------------------------------------ buildings

/** Calm height ramp; a (softened) OSM building:colour tints the walls when tagged. */
const BUILDING_RAMP: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["get", "h"],
  0,
  "#F4F2EC",
  15,
  "#EEEDE8",
  40,
  "#E4E7E6",
  90,
  "#D8DFE2",
  200,
  "#C9D3DA",
];
const isSlice: ExpressionSpecification = ["==", ["get", "rs"], 1];
const notSlice: ExpressionSpecification = ["!=", ["get", "rs"], 1];
/** Measured height or levels — everything else is an explicit estimate (lighter, more transparent). */
const isMeasured: ExpressionSpecification = ["in", ["get", "src"], ["literal", ["height", "levels"]]];
/** An outline whose building:parts reach the ground is drawn by the parts in 3D (Simple 3D Buildings). */
const notOutlineWithParts: ExpressionSpecification = ["!=", ["get", "has_parts"], 1];
const wallColor: ExpressionSpecification = [
  "case",
  // Roof slices: tagged roof colour, else the wall colour for stylised landmarks, else a light roof.
  isSlice,
  ["case", ["has", "rcol"], ["to-color", ["get", "rcol"], COLORS.roof], ["has", "col"], ["to-color", ["get", "col"], COLORS.roof], COLORS.roof],
  ["has", "col"],
  ["to-color", ["get", "col"], "#E3E2DA"],
  BUILDING_RAMP,
];

function buildingLayers(mode: ViewMode, hybrid: boolean): LayerSpecification[] {
  const v3 = mode === "3d" ? "visible" : "none";
  const v2 = mode === "2d" ? "visible" : "none";
  const height: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 13, 0, 14, ["get", "h"]];
  const base: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 13, 0, 14, ["coalesce", ["get", "mh"], 0]];
  return [
    // Soft contact shadow under footprints (2D and 3D).
    {
      id: "buildings-shadow",
      type: "fill",
      source: "buildings",
      "source-layer": "buildings",
      minzoom: 14,
      filter: ["all", notSlice, ["!=", ["get", "part"], 1]],
      paint: {
        "fill-color": "#646A60",
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, 0.14],
        "fill-translate": ["interpolate", ["exponential", 2], ["zoom"], 14, ["literal", [0.6, -0.8]], 18, ["literal", [9, -12]]],
        "fill-translate-anchor": "map",
      },
    },
    {
      id: "buildings-2d",
      type: "fill",
      source: "buildings",
      "source-layer": "buildings",
      filter: ["all", notSlice, ["!=", ["get", "part"], 1]],
      layout: { visibility: v2 },
      paint: {
        "fill-color": wallColor,
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 14, ["case", isMeasured, 1, 0.78]],
      },
    },
    {
      id: "buildings-2d-outline",
      type: "line",
      source: "buildings",
      "source-layer": "buildings",
      minzoom: 14.5,
      filter: ["all", notSlice, ["!=", ["get", "part"], 1]],
      layout: { visibility: v2 },
      paint: {
        "line-color": "#BFC4BB",
        "line-width": ["interpolate", ["linear"], ["zoom"], 15, 0.5, 18, 1.2],
        "line-dasharray": ["case", isMeasured, ["literal", [1, 0]], ["literal", [2, 1.5]]],
      },
    },
    // fill-extrusion-opacity is not data-driven: estimated heights get their own lighter, more
    // transparent layer so they read as "условная высота".
    {
      id: "buildings-3d",
      type: "fill-extrusion",
      source: "buildings",
      "source-layer": "buildings",
      minzoom: 13,
      filter: ["all", isMeasured, notOutlineWithParts],
      layout: { visibility: v3 },
      paint: {
        "fill-extrusion-color": wallColor,
        "fill-extrusion-height": height,
        "fill-extrusion-base": base,
        "fill-extrusion-opacity": hybrid ? 0.97 : 1,
        "fill-extrusion-vertical-gradient": true,
      },
    },
    {
      id: "buildings-3d-approx",
      type: "fill-extrusion",
      source: "buildings",
      "source-layer": "buildings",
      minzoom: 13,
      filter: ["all", ["!", isMeasured], notOutlineWithParts],
      layout: { visibility: v3 },
      paint: {
        "fill-extrusion-color": ["case", isSlice, COLORS.roof, ["has", "col"], ["to-color", ["get", "col"], COLORS.buildingDefault], COLORS.buildingDefault],
        "fill-extrusion-height": height,
        "fill-extrusion-base": base,
        "fill-extrusion-opacity": 0.82,
        "fill-extrusion-vertical-gradient": true,
      },
    },
    // Thin roof slab on flat measured roofs: a lighter cap with a crisp edge reads as a roof.
    {
      id: "buildings-roof",
      type: "fill-extrusion",
      source: "buildings",
      "source-layer": "buildings",
      minzoom: 15,
      filter: ["all", isMeasured, notOutlineWithParts, notSlice, ["!=", ["get", "roofed"], 1]],
      layout: { visibility: v3 },
      paint: {
        "fill-extrusion-color": ["case", ["has", "rcol"], ["to-color", ["get", "rcol"], COLORS.roof], COLORS.roof],
        "fill-extrusion-height": ["+", ["get", "h"], 0.6],
        "fill-extrusion-base": ["get", "h"],
        "fill-extrusion-opacity": 1,
        "fill-extrusion-vertical-gradient": false,
      },
    },
  ];
}

// ------------------------------------------------------------------ ground

function satelliteRaster(opacity: number | ExpressionSpecification): LayerSpecification {
  return {
    id: "satellite",
    type: "raster",
    source: "satellite",
    // Fully faded out from HYBRID_FADE[1]: no imagery requests and no EOX attribution at street level.
    maxzoom: HYBRID_FADE[1],
    paint: {
      "raster-opacity": opacity,
      "raster-saturation": -0.2,
      "raster-contrast": 0.08,
      "raster-brightness-max": 0.92,
      "raster-fade-duration": 200,
    },
  };
}

function groundLayers(hybrid: boolean): LayerSpecification[] {
  const layers: LayerSpecification[] = [
    { id: "background", type: "background", paint: { "background-color": COLORS.background } },
    { id: "earth", type: "fill", source: "base", "source-layer": "earth", filter: isPoly, paint: { "fill-color": COLORS.background } },
    {
      id: "landuse-urban",
      type: "fill",
      source: "base",
      "source-layer": "landuse",
      filter: kindIn("residential", "commercial", "industrial", "railway", "military", "school", "kindergarten", "university", "college", "hospital"),
      paint: {
        "fill-color": [
          "match",
          ["get", "kind"],
          ["industrial", "railway", "military"],
          "#E6E3DB",
          ["school", "kindergarten", "university", "college", "hospital"],
          "#EDE8DC",
          "#EAE9E2",
        ],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.6, 15, 1],
      },
    },
    {
      id: "landuse-farm",
      type: "fill",
      source: "base",
      "source-layer": "landuse",
      filter: kindIn("farmland", "grassland", "scrub", "allotments", "wetland", "village_green"),
      paint: { "fill-color": ["match", ["get", "kind"], "wetland", "#D9E6DA", "#E3E8D3"], "fill-opacity": 0.85 },
    },
    {
      id: "landuse-green",
      type: "fill",
      source: "base",
      "source-layer": "landuse",
      filter: kindIn("park", "garden", "grass", "forest", "wood", "recreation_ground", "cemetery", "playground", "pitch", "golf_course", "zoo"),
      paint: {
        "fill-color": ["match", ["get", "kind"], ["forest", "wood"], "#C4DAAE", ["pitch", "playground"], "#CFE2BC", "cemetery", "#D6E0CB", COLORS.green],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.7, 14, 1],
      },
    },
    { id: "landuse-pedestrian", type: "fill", source: "base", "source-layer": "landuse", minzoom: 13, filter: kindIn("pedestrian", "platform"), paint: { "fill-color": "#F6F4EE" } },
    {
      id: "water",
      type: "fill",
      source: "base",
      "source-layer": "water",
      filter: ["all", isPoly, ["!", kindIn("swimming_pool")]],
      paint: { "fill-color": COLORS.water },
    },
    {
      id: "water-shore",
      type: "line",
      source: "base",
      "source-layer": "water",
      minzoom: 13,
      filter: ["all", isPoly, kindIn("water", "lake", "river", "basin")],
      paint: { "line-color": "#93BDD3", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.5, 18, 1.5] },
    },
    {
      id: "waterway",
      type: "line",
      source: "base",
      "source-layer": "water",
      filter: ["all", isLine, kindIn("river", "canal", "stream")],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": COLORS.water, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.8, 16, 3, 19, 8] },
    },
  ];
  if (hybrid) layers.push(satelliteRaster(["interpolate", ["linear"], ["zoom"], HYBRID_FADE[0], 1, HYBRID_FADE[1], 0]));
  return layers;
}

function roadLayers(hybrid: boolean): LayerSpecification[] {
  const p = (a: Value, b: Value) => pick(hybrid, a, b);
  const major: ExpressionSpecification = ["any", ["==", ["get", "kind"], "highway"], detailIn("trunk", "primary")];
  return [
    {
      id: "rail",
      type: "line",
      source: "base",
      "source-layer": "roads",
      minzoom: 11,
      filter: ["all", ["==", ["get", "kind"], "rail"], notTunnel],
      paint: {
        "line-color": p("#D9D6CC", "#B9B9B1"),
        "line-opacity": p(0.6, 1),
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 17, 2],
        "line-dasharray": [3, 2],
      },
    },
    {
      id: "paths",
      type: "line",
      source: "base",
      "source-layer": "roads",
      minzoom: 15,
      filter: ["all", isPath, ["!", detailIn("track")]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#FFFFFF", "line-opacity": p(0.45, 0.95), "line-width": ["interpolate", ["linear"], ["zoom"], 15, 0.8, 18, 2.4] },
    },
    {
      id: "roads-casing",
      type: "line",
      source: "base",
      "source-layer": "roads",
      filter: ["all", isCarRoad, notTunnel],
      layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["get", "sort_rank"] },
      paint: { "line-color": p("#1B2420", COLORS.roadCasing), "line-opacity": p(0.35, 1), "line-width": roadWidth(true) },
    },
    {
      id: "roads",
      type: "line",
      source: "base",
      "source-layer": "roads",
      filter: ["all", isCarRoad, notTunnel],
      layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["get", "sort_rank"] },
      paint: {
        "line-color": p(["case", major, "#FFE9A8", "#FFFFFF"], ["case", major, "#FFFDF4", COLORS.road]),
        "line-opacity": p(0.6, 1),
        "line-width": roadWidth(false),
      },
    },
  ];
}

function labelLayers(hybrid: boolean): LayerSpecification[] {
  const p = (a: Value, b: Value) => pick(hybrid, a, b);
  const text = p("#FFFFFF", COLORS.label);
  const halo = p("rgba(15,22,18,0.85)", COLORS.labelHalo);
  return [
    {
      id: "waterway-labels",
      type: "symbol",
      source: "base",
      "source-layer": "water",
      minzoom: 13,
      filter: ["all", isLine, kindIn("river", "canal"), ["has", "name"]],
      layout: {
        "symbol-placement": "line",
        "text-field": NAME,
        "text-font": [FONT_SEMI],
        "text-size": ["interpolate", ["linear"], ["zoom"], 13, 11, 17, 14],
        "text-letter-spacing": 0.08,
        "symbol-spacing": 500,
      },
      paint: { "text-color": p("#D5EEF8", "#3D6F8A"), "text-halo-color": p("rgba(10,30,40,0.8)", "#E7F1F5"), "text-halo-width": 1.4 },
    },
    {
      id: "road-labels",
      type: "symbol",
      source: "base",
      "source-layer": "roads",
      minzoom: 13,
      filter: ["all", isCarRoad, ["has", "name"], [">=", ["zoom"], ["+", ROAD_MIN_ZOOM, 1.5]]],
      layout: {
        "symbol-placement": "line",
        "text-field": NAME,
        "text-font": [MAP_FONT],
        "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 18, 14],
        "text-max-angle": 30,
        "symbol-spacing": 360,
        "symbol-sort-key": ["get", "sort_rank"],
      },
      paint: { "text-color": text, "text-halo-color": halo, "text-halo-width": 1.6 },
    },
    {
      id: "park-labels",
      type: "symbol",
      source: "base",
      "source-layer": "pois",
      minzoom: 14,
      filter: ["all", kindIn("park", "garden"), ["has", "name"]],
      layout: { "text-field": NAME, "text-font": [FONT_SEMI], "text-size": 11.5, "text-max-width": 8, "text-padding": 6 },
      paint: { "text-color": p("#E6F5D3", "#3E6A2C"), "text-halo-color": p("rgba(14,26,12,0.85)", "#EEF5E6"), "text-halo-width": 1.5 },
    },
    {
      id: "district-labels",
      type: "symbol",
      source: "base",
      "source-layer": "places",
      minzoom: 11,
      maxzoom: 16,
      filter: kindIn("neighbourhood", "macrohood"),
      layout: {
        "text-field": NAME,
        "text-font": [FONT_BOLD],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.12,
        "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10, 15, 13],
        "text-max-width": 7,
        "text-padding": 12,
      },
      paint: { "text-color": p("#F4F1E8", "#59645D"), "text-halo-color": halo, "text-halo-width": 1.8 },
    },
    {
      id: "locality-labels",
      type: "symbol",
      source: "base",
      "source-layer": "places",
      maxzoom: 14,
      filter: ["all", ["==", ["get", "kind"], "locality"], ["!=", ["get", "kind_detail"], "city"]],
      layout: { "text-field": NAME, "text-font": [FONT_SEMI], "text-size": 12, "text-max-width": 8 },
      paint: { "text-color": text, "text-halo-color": halo, "text-halo-width": 1.6 },
    },
    // Stylised landmark models are labelled as such on the map (e.g. «Нур Алем · стилизация»).
    {
      id: "stylised-labels",
      type: "symbol",
      source: "buildings",
      "source-layer": "buildings",
      minzoom: 15,
      filter: ["has", "lbl"],
      layout: {
        "text-field": ["get", "lbl"],
        "text-font": [FONT_SEMI],
        "text-size": 12,
        "text-offset": [0, 1.4],
        "text-allow-overlap": false,
      },
      paint: { "text-color": COLORS.label, "text-halo-color": "#FFFFFF", "text-halo-width": 1.8 },
    },
  ];
}

// ------------------------------------------------------------------ coverage and boundary

/** Label on the boundary of the recommendation database (much smaller than the base map). */
export const COVERAGE_LABEL = "Зона рекомендаций SmartCity";
export const BOUNDARY_LABEL = "Граница Астаны (OSM)";

function overlayLayers(hybrid: boolean): LayerSpecification[] {
  const p = (a: Value, b: Value) => pick(hybrid, a, b);
  return [
    {
      id: "boundary-line",
      type: "line",
      source: "boundary",
      maxzoom: 15,
      layout: { "line-join": "round" },
      paint: {
        "line-color": p("#E9DDFF", COLORS.boundary),
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.2, 14, 2],
        "line-opacity": 0.7,
        "line-dasharray": [6, 3],
      },
    },
    {
      id: "coverage-fill",
      type: "fill",
      source: "coverage",
      paint: { "fill-color": COLORS.coverageAccent, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.18, 15, 0.04] },
    },
    {
      id: "coverage-line",
      type: "line",
      source: "coverage",
      layout: { "line-join": "round" },
      paint: {
        "line-color": p("#F3FFD6", COLORS.coverage),
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.5, 16, 2.5],
        "line-opacity": 0.8,
        "line-dasharray": [3, 2],
      },
    },
  ];
}

function overlayLabels(hybrid: boolean): LayerSpecification[] {
  const p = (a: Value, b: Value) => pick(hybrid, a, b);
  return [
    {
      id: "boundary-label",
      type: "symbol",
      source: "boundary",
      maxzoom: 13,
      layout: {
        "symbol-placement": "line",
        "text-field": BOUNDARY_LABEL,
        "text-font": [FONT_SEMI],
        "text-size": 11,
        "symbol-spacing": 600,
        "text-offset": [0, -0.8],
      },
      paint: { "text-color": p("#F1E9FF", "#5B3F86"), "text-halo-color": p("rgba(20,12,30,0.85)", "#FFFFFF"), "text-halo-width": 1.8 },
    },
    // City scale: one label in the middle of the zone; closer in it runs along the dashed border.
    {
      id: "coverage-name",
      type: "symbol",
      source: "coverage",
      maxzoom: 12.5,
      layout: {
        "symbol-placement": "point",
        "text-field": "Зона рекомендаций",
        "text-font": [FONT_BOLD],
        "text-size": 12,
        "text-max-width": 7,
      },
      paint: { "text-color": p("#F5FBE6", COLORS.coverage), "text-halo-color": p("rgba(15,22,18,0.9)", "#F2F8DF"), "text-halo-width": 2 },
    },
    {
      id: "coverage-label",
      type: "symbol",
      source: "coverage",
      minzoom: 12.5,
      layout: {
        "symbol-placement": "line",
        "text-field": COVERAGE_LABEL,
        "text-font": [FONT_BOLD],
        "text-size": ["interpolate", ["linear"], ["zoom"], 11, 11, 16, 13],
        "text-letter-spacing": 0.04,
        "symbol-spacing": 420,
        "text-offset": [0, -0.9],
      },
      paint: { "text-color": p("#F5FBE6", COLORS.coverage), "text-halo-color": p("rgba(15,22,18,0.9)", "#F2F8DF"), "text-halo-width": 2 },
    },
  ];
}

// ------------------------------------------------------------------ style

export interface StyleOptions {
  glyphsUrl: string;
  tilesUrl: string; // e.g. https://host/api/tiles — /{set}/{z}/{x}/{y} is appended
  /** Archive version from /api/basemap: appended as ?v= so a rebuild changes every tile URL. */
  tilesVersion?: string | null;
  mode: ViewMode;
  variant?: BasemapVariant;
  /** Satellite source allowed by the API (licence/usage mode); null → no satellite, hybrid falls back to scheme. */
  satellite?: SatelliteSource | null;
  coverage?: GeoJSON.FeatureCollection;
  boundary?: GeoJSON.FeatureCollection;
}

/** The variant actually rendered: hybrid needs a licensed satellite source. */
export const effectiveVariant = (variant: BasemapVariant | undefined, satellite: SatelliteSource | null | undefined): BasemapVariant =>
  variant === "hybrid" && satellite ? "hybrid" : "scheme";

export function buildMapStyle(opts: StyleOptions): StyleSpecification {
  const variant = effectiveVariant(opts.variant, opts.satellite);
  const hybrid = variant === "hybrid";
  const v = opts.tilesVersion ? `?v=${opts.tilesVersion}` : "";
  const sources: Record<string, SourceSpecification> = {
    base: { type: "vector", tiles: [`${opts.tilesUrl}/base/{z}/{x}/{y}${v}`], minzoom: 0, maxzoom: 15, bounds: CITY_BOUNDS, attribution: "" },
    buildings: { type: "vector", tiles: [`${opts.tilesUrl}/buildings/{z}/{x}/{y}${v}`], minzoom: 13, maxzoom: 15, bounds: CITY_BOUNDS, attribution: "" },
    coverage: { type: "geojson", data: (opts.coverage ?? EMPTY) as GeoJSON.FeatureCollection, attribution: "" },
    boundary: { type: "geojson", data: (opts.boundary ?? EMPTY) as GeoJSON.FeatureCollection, attribution: "" },
  };
  if (hybrid && opts.satellite) {
    sources.satellite = {
      type: "raster",
      tiles: opts.satellite.tiles,
      tileSize: 256,
      maxzoom: opts.satellite.maxzoom,
      bounds: CITY_BOUNDS,
      attribution: opts.satellite.attribution,
    };
  }
  return {
    version: 8,
    name: `SmartCity Astana (${variant})`,
    glyphs: opts.glyphsUrl,
    light: { anchor: "map", position: [1.3, 205, 35], color: "#FFFFFF", intensity: 0.2 },
    sky: { "sky-color": "#CFE1EC", "horizon-color": "#EEF2F0", "fog-color": "#EFEEE7", "fog-ground-blend": 0.7, "horizon-fog-blend": 0.7, "sky-horizon-blend": 0.6, "atmosphere-blend": 0 },
    sources,
    layers: [
      ...groundLayers(hybrid),
      ...overlayLayers(hybrid),
      ...roadLayers(hybrid),
      ...buildingLayers(opts.mode, hybrid),
      ...labelLayers(hybrid),
      ...overlayLabels(hybrid),
    ],
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
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a> · <a href="https://protomaps.com" target="_blank" rel="noopener noreferrer">Protomaps</a>';
