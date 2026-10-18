import { describe, expect, it } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { LAYERS_2D, LAYERS_3D, buildMapStyle, pitchFor, viewModeVisibility } from "@/lib/mapStyle";

const GLYPHS = "http://localhost/fonts/{fontstack}/{range}.pbf";

describe("map style", () => {
  const style3d = buildMapStyle({ glyphsUrl: GLYPHS, mode: "3d" });
  type L = { type: string; paint: Record<string, unknown>; layout: Record<string, unknown>; filter?: unknown };
  const layer = (id: string) => style3d.layers.find((l) => l.id === id) as unknown as L;

  it("is a valid MapLibre style", () => {
    expect(validateStyleMin(style3d)).toEqual([]);
    expect(validateStyleMin(buildMapStyle({ glyphsUrl: GLYPHS, mode: "2d" }))).toEqual([]);
  });

  it("uses only own GeoJSON sources and local glyphs (no external tiles)", () => {
    for (const src of Object.values(style3d.sources)) expect(src.type).toBe("geojson");
    expect(Object.keys(style3d.sources).sort()).toEqual(["buildings", "coverage", "green", "roads", "water"]);
    expect(style3d.glyphs).toBe(GLYPHS);
    expect(JSON.stringify(style3d)).not.toMatch(/tile\.openstreetmap|api\.maptiler|mapbox\.com/);
  });

  it("has fill-extrusion layers driven by height_m / min_height_m", () => {
    const ext = layer("buildings-3d");
    expect(ext?.type).toBe("fill-extrusion");
    const paint = JSON.stringify(ext.paint);
    expect(paint).toContain("height_m");
    expect(paint).toContain("min_height_m");
    expect(layer("buildings-3d-default")?.type).toBe("fill-extrusion");
  });

  it("renders approximate (default) heights more transparently than measured ones", () => {
    const measured = layer("buildings-3d").paint["fill-extrusion-opacity"] as number;
    const approx = layer("buildings-3d-default").paint["fill-extrusion-opacity"] as number;
    expect(approx).toBeLessThan(measured);
    expect(JSON.stringify(layer("buildings-3d-default").filter)).toContain("default");
  });

  it("starts in the requested mode and switches 2D ↔ 3D via visibility", () => {
    for (const id of LAYERS_3D) expect(layer(id).layout.visibility).toBe("visible");
    for (const id of LAYERS_2D) expect(layer(id).layout.visibility).toBe("none");
    const to2d = Object.fromEntries(viewModeVisibility("2d"));
    expect(to2d["buildings-3d"]).toBe("none");
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
