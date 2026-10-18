import { describe, expect, it } from "vitest";
import { collectionBounds, heightStats, isValidGeometry, parseLayer, pointInCoverage } from "@/lib/mapData";
import { buildings, coverageLayer } from "../fixtures/synthetic";

describe("parseLayer", () => {
  it("keeps valid buildings including polygons with holes", () => {
    const r = parseLayer("buildings", buildings());
    expect(r.dropped).toBe(0);
    expect(r.data.features.length).toBe(31);
    const courtyard = r.data.features.find((f) => (f.properties as { id: string }).id === "way/9999");
    expect((courtyard?.geometry as { coordinates: unknown[] }).coordinates.length).toBe(2);
  });

  it("drops invalid features and counts them (partial data)", () => {
    const fc = buildings();
    fc.features.push(
      { type: "Feature", properties: { id: "x", height_m: 10, min_height_m: 0, height_source: "default" }, geometry: { type: "Point", coordinates: [71, 51] } },
      { type: "Feature", properties: { id: "y", height_m: "tall", height_source: "default" }, geometry: fc.features[0]!.geometry },
      { type: "Feature", properties: { id: "z", height_m: 10, min_height_m: 20, height_source: "height" }, geometry: fc.features[0]!.geometry },
      { type: "Feature", properties: { id: "w", height_m: 10, height_source: "guess" }, geometry: fc.features[0]!.geometry },
    );
    const r = parseLayer("buildings", fc);
    expect(r.dropped).toBe(4);
    expect(r.data.features.length).toBe(31);
  });

  it("throws on a non-FeatureCollection", () => {
    expect(() => parseLayer("roads", { type: "Feature" })).toThrow();
    expect(() => parseLayer("roads", null)).toThrow();
  });

  it("rejects swapped / out-of-range coordinates and unclosed rings", () => {
    expect(isValidGeometry({ type: "LineString", coordinates: [[71.4, 51.0], [200, 51]] }, ["LineString"])).toBe(false);
    expect(isValidGeometry({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 1]]] }, ["Polygon"])).toBe(false);
    expect(isValidGeometry({ type: "LineString", coordinates: [[71.4, 51.0], [71.5, 51.1]] }, ["LineString"])).toBe(true);
  });
});

describe("height stats & coverage", () => {
  it("counts height provenance", () => {
    expect(heightStats(buildings())).toEqual({ height: 11, levels: 10, default: 10 });
  });

  it("checks coverage with [lon, lat] order", () => {
    const cov = coverageLayer();
    expect(pointInCoverage(71.414, 51.089, cov)).toBe(true);
    expect(pointInCoverage(51.089, 71.414, cov)).toBe(false); // swapped order is outside
    expect(pointInCoverage(76.9, 43.2, cov)).toBe(false); // Almaty
    expect(pointInCoverage(71.414, 51.089, undefined)).toBeNull();
  });

  it("respects holes", () => {
    const fc = buildings();
    const courtyard = fc.features.find((f) => (f.properties as { id: string }).id === "way/9999")!;
    const one = { type: "FeatureCollection" as const, features: [courtyard] };
    expect(pointInCoverage(71.4225, 51.0915, one)).toBe(true); // in the outer ring, outside hole
    expect(pointInCoverage(71.4235, 51.092, one)).toBe(false); // inside the hole
  });

  it("computes bounds", () => {
    const b = collectionBounds(coverageLayer())!;
    [71.4, 51.081, 71.428, 51.099].forEach((v, i) => expect(b[i]).toBeCloseTo(v, 9));
  });
});
