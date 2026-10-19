import { describe, expect, it } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import {
  CITY_BOUNDS,
  LAYERS_2D,
  LAYERS_3D,
  buildMapStyle,
  effectiveVariant,
  pitchFor,
  viewModeVisibility,
  type SatelliteSource,
} from "@/lib/mapStyle";
import { featureBounds } from "@/components/map/MapView";

const GLYPHS = "http://localhost/fonts/{fontstack}/{range}.pbf";
const TILES = "http://localhost/api/tiles";
const SAT: SatelliteSource = {
  tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg"],
  maxzoom: 14,
  attribution: "EOxCloudless … (Contains modified Copernicus Sentinel data 2024) · CC BY-NC-SA 4.0",
};

type L = { id: string; type: string; source?: string; paint: Record<string, unknown>; layout: Record<string, unknown>; filter?: unknown };

describe("map style", () => {
  const scheme = buildMapStyle({ glyphsUrl: GLYPHS, tilesUrl: TILES, mode: "3d", variant: "scheme" });
  const hybrid = buildMapStyle({ glyphsUrl: GLYPHS, tilesUrl: TILES, mode: "3d", variant: "hybrid", satellite: SAT });
  const layer = (id: string, s = scheme) => s.layers.find((l) => l.id === id) as unknown as L;

  it("is a valid MapLibre style in every variant and mode", () => {
    for (const mode of ["3d", "2d"] as const) {
      expect(validateStyleMin(buildMapStyle({ glyphsUrl: GLYPHS, tilesUrl: TILES, mode }))).toEqual([]);
      expect(validateStyleMin(buildMapStyle({ glyphsUrl: GLYPHS, tilesUrl: TILES, mode, variant: "hybrid", satellite: SAT }))).toEqual([]);
    }
  });

  it("loads the city from same-origin vector tiles by visible area, bounded to Astana", () => {
    const base = scheme.sources.base as { type: string; tiles: string[]; bounds: number[]; maxzoom: number };
    const bld = scheme.sources.buildings as { type: string; tiles: string[]; minzoom: number };
    expect(base.type).toBe("vector");
    expect(base.tiles).toEqual([`${TILES}/base/{z}/{x}/{y}`]);
    expect(base.bounds).toEqual(CITY_BOUNDS);
    expect(base.maxzoom).toBe(15);
    expect(bld.tiles).toEqual([`${TILES}/buildings/{z}/{x}/{y}`]);
    expect(bld.minzoom).toBe(13);
    expect(scheme.glyphs).toBe(GLYPHS);
    expect(Object.keys(scheme.sources).sort()).toEqual(["base", "boundary", "buildings", "coverage"]);
    expect(JSON.stringify(scheme)).not.toMatch(/tile\.openstreetmap|api\.maptiler|mapbox\.com|eox\.at/);
  });

  it("versions tile URLs with the archive version from the API", () => {
    const st = buildMapStyle({ glyphsUrl: GLYPHS, tilesUrl: TILES, mode: "3d", tilesVersion: "ab12" });
    expect((st.sources.base as { tiles: string[] }).tiles).toEqual([`${TILES}/base/{z}/{x}/{y}?v=ab12`]);
    expect((st.sources.buildings as { tiles: string[] }).tiles).toEqual([`${TILES}/buildings/{z}/{x}/{y}?v=ab12`]);
  });

  it("adds the satellite only in hybrid with a licensed source, fading out on approach", () => {
    expect(hybrid.sources.satellite).toMatchObject({ type: "raster", maxzoom: 14, attribution: SAT.attribution });
    const opacity = JSON.stringify(layer("satellite", hybrid).paint["raster-opacity"]);
    expect(opacity).toBe(JSON.stringify(["interpolate", ["linear"], ["zoom"], 14.5, 1, 16, 0]));
    // Not rendered (no requests, no EOX credit) at street level, where it would be fully transparent.
    expect((layer("satellite", hybrid) as unknown as { maxzoom: number }).maxzoom).toBe(16);
    // No licensed source (e.g. commercial mode) → hybrid silently degrades to the scheme, no EOX request.
    const noSat = buildMapStyle({ glyphsUrl: GLYPHS, tilesUrl: TILES, mode: "3d", variant: "hybrid", satellite: null });
    expect(noSat.sources.satellite).toBeUndefined();
    expect(JSON.stringify(noSat)).not.toContain("eox.at");
    expect(effectiveVariant("hybrid", null)).toBe("scheme");
    expect(effectiveVariant("hybrid", SAT)).toBe("hybrid");
    expect(effectiveVariant("scheme", SAT)).toBe("scheme");
  });

  it("extrudes buildings by h / mh, measured heights opaque and estimates lighter", () => {
    const measured = layer("buildings-3d");
    const approx = layer("buildings-3d-approx");
    expect(measured.type).toBe("fill-extrusion");
    expect(JSON.stringify(measured.paint["fill-extrusion-height"])).toContain('["get","h"]');
    expect(JSON.stringify(measured.paint["fill-extrusion-base"])).toContain('["get","mh"]');
    expect(JSON.stringify(measured.filter)).toContain('["height","levels"]');
    expect(JSON.stringify(approx.filter)).toContain('["!",');
    expect(approx.paint["fill-extrusion-opacity"] as number).toBeLessThan(measured.paint["fill-extrusion-opacity"] as number);
  });

  it("draws roof slices in 3D only and hides outlines drawn by their parts", () => {
    expect(JSON.stringify(layer("buildings-2d").filter)).toContain('["!=",["get","rs"],1]');
    expect(JSON.stringify(layer("buildings-3d").filter)).toContain('["!=",["get","has_parts"],1]');
    expect(JSON.stringify(layer("buildings-roof").filter)).toContain('["!=",["get","roofed"],1]');
  });

  it("labels stylised landmark models and both coverages", () => {
    expect(layer("stylised-labels").layout["text-field"]).toEqual(["get", "lbl"]);
    expect(layer("coverage-label").layout["text-field"]).toBe("Зона рекомендаций SmartCity");
    expect(layer("boundary-label").layout["text-field"]).toBe("Граница Астаны (OSM)");
    expect(layer("coverage-line").source).toBe("coverage");
    expect(layer("boundary-line").source).toBe("boundary");
  });

  it("starts in the requested mode and switches 2D ↔ 3D via visibility", () => {
    for (const id of LAYERS_3D) expect(layer(id).layout.visibility).toBe("visible");
    for (const id of LAYERS_2D) expect(layer(id).layout.visibility).toBe("none");
    const to2d = Object.fromEntries(viewModeVisibility("2d"));
    expect(to2d["buildings-3d"]).toBe("none");
    expect(to2d["buildings-3d-approx"]).toBe("none");
    expect(to2d["buildings-2d"]).toBe("visible");
    expect(pitchFor("2d")).toBe(0);
    expect(pitchFor("3d")).toBeGreaterThan(40);
  });

  it("labels streets with a symbol layer using the local font", () => {
    const labels = layer("road-labels");
    expect(labels.type).toBe("symbol");
    expect(labels.layout["text-font"]).toEqual(["Manrope-Regular"]);
  });
});

describe("result marker stacking (overlapping places)", () => {
  it("lower numbers stay above higher ones; the selected marker is above all", async () => {
    const { markerZ } = await import("@/components/map/MapView");
    expect(markerZ(0, false)).toBeGreaterThan(markerZ(1, false));
    expect(markerZ(1, false)).toBeGreaterThan(markerZ(2, false));
    expect(markerZ(2, true)).toBeGreaterThan(markerZ(0, false));
  });
});

describe("coverage bounds for «Показать зону»", () => {
  it("computes [[w,s],[e,n]] of polygons and null for empty data", () => {
    const fc = {
      type: "FeatureCollection" as const,
      features: [
        { type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [[[71.39, 51.07], [71.44, 51.07], [71.44, 51.1], [71.39, 51.07]]] } },
      ],
    };
    expect(featureBounds(fc)).toEqual([[71.39, 51.07], [71.44, 51.1]]);
    expect(featureBounds(undefined)).toBeNull();
  });
});
