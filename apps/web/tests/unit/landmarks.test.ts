import { describe, expect, it } from "vitest";
import { BAITEREK, NUR_ALEM, baiterekPieces, landmarkModels, nurAlemPieces, sphereSlices } from "@/lib/landmarks";
import { facadeImage, FACADE_SIZE } from "@/lib/facades";
import { detailTier } from "@/lib/deviceTier";
import { markOffsets } from "@/lib/walkingRoute";
import { FACADES } from "@/lib/mapStyle";

const radiusM = (ring: number[][], centre: [number, number]) => {
  const [lon, lat] = centre;
  return Math.max(...ring.map(([x, y]) => Math.hypot((x! - lon) * 111_320 * Math.cos((lat * Math.PI) / 180), (y! - lat) * 110_540)));
};

describe("landmark models", () => {
  it("a sphere is a stack of discs that widens to the equator and narrows again — never a cylinder", () => {
    const s = sphereSlices([71.4, 51.1], 20, 100, 16, 32, () => "#ccc", "orb");
    const radii = s.map((f) => radiusM(f.geometry.coordinates[0]!, [71.4, 51.1]));
    const max = Math.max(...radii);
    expect(max).toBeGreaterThan(9.5);
    expect(max).toBeLessThanOrEqual(10.01);
    expect(radii[0]!).toBeLessThan(max * 0.6);
    expect(radii[radii.length - 1]!).toBeLessThan(max * 0.6);
    expect(Math.min(...s.map((f) => f.properties.mh))).toBeGreaterThanOrEqual(80);
    expect(Math.max(...s.map((f) => f.properties.h))).toBeCloseTo(100, 5);
  });

  it("Baiterek: OSM orb (Ø 21.9 m, top 30 levels × 3.2 m, OSM colour) on a white trunk and crown", () => {
    const p = baiterekPieces("high");
    const orb = p.filter((f) => f.properties.part === "orb");
    expect(Math.max(...orb.map((f) => f.properties.h))).toBeCloseTo(96, 5);
    expect(Math.min(...orb.map((f) => f.properties.mh))).toBeCloseTo(96 - 21.9, 1);
    expect(orb.some((f) => f.properties.c === "#C3B391")).toBe(true);
    const orbR = Math.max(...orb.map((f) => radiusM(f.geometry.coordinates[0]!, BAITEREK.centre)));
    expect(orbR).toBeCloseTo(21.9 / 2, 0);
    const trunk = p.find((f) => f.properties.part === "trunk")!;
    expect(radiusM(trunk.geometry.coordinates[0]!, BAITEREK.centre)).toBeLessThan(4);
    expect(p.filter((f) => f.properties.part === "rib").length).toBeGreaterThan(100);
    expect(p.filter((f) => f.properties.lbl).map((f) => f.properties.lbl)).toEqual(["Байтерек · стилизация"]);
  });

  it("Nur Alem: Ø 78.1 m sphere with its top at OSM height 100 m, glazing bands alternate", () => {
    const p = nurAlemPieces("high");
    const sphere = p.filter((f) => f.properties.part === "sphere");
    expect(Math.max(...sphere.map((f) => f.properties.h))).toBeCloseTo(100, 5);
    expect(Math.min(...sphere.map((f) => f.properties.mh))).toBeCloseTo(100 - 78.1, 1);
    expect(new Set(sphere.map((f) => f.properties.c)).size).toBe(2);
    expect(Math.max(...sphere.map((f) => radiusM(f.geometry.coordinates[0]!, NUR_ALEM.centre)))).toBeCloseTo(78.1 / 2, 0);
  });

  it("low detail is lighter but keeps the shapes", () => {
    const hi = landmarkModels("high").features.length;
    const lo = landmarkModels("low").features.length;
    expect(lo).toBeLessThan(hi / 2);
    expect(baiterekPieces("low").some((f) => f.properties.part === "orb")).toBe(true);
  });

  it("every model names its OSM sources", () => {
    for (const m of [BAITEREK, NUR_ALEM]) {
      expect(m.sources.length).toBeGreaterThanOrEqual(2);
      expect(m.label).toMatch(/стилизация/);
    }
  });
});

describe("procedural facades, detail tier and mark offsets", () => {
  it("facade patterns are opaque RGBA tiles with distinct glass and wall colours", () => {
    for (const id of FACADES) {
      const img = facadeImage(id);
      expect(img.width).toBe(FACADE_SIZE);
      expect(img.data.length).toBe(FACADE_SIZE * FACADE_SIZE * 4);
      const colours = new Set<string>();
      for (let i = 0; i < img.data.length; i += 4) { expect(img.data[i + 3]).toBe(255); colours.add(`${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`); }
      expect(colours.size).toBeGreaterThanOrEqual(2);
    }
  });

  it("weak devices get low detail; ?detail= overrides", () => {
    expect(detailTier({ hardwareConcurrency: 8, deviceMemory: 8 })).toBe("high");
    expect(detailTier({ deviceMemory: 2 })).toBe("low");
    expect(detailTier({ saveData: true, hardwareConcurrency: 16 })).toBe("low");
    expect(detailTier({ coarsePointer: true, hardwareConcurrency: 4 })).toBe("low");
    expect(detailTier({ coarsePointer: true, hardwareConcurrency: 8, deviceMemory: 8 })).toBe("high");
    expect(detailTier({ search: "?detail=high", deviceMemory: 1 })).toBe("high");
    expect(detailTier({ search: "?detail=low", deviceMemory: 16 })).toBe("low");
  });

  it("marks closer than 120 m are pushed apart; distant marks stay on their points", () => {
    const close = markOffsets([[71.4300, 51.1280], [71.4305, 51.1281]]);
    expect(close[0]).toEqual([0, 0]);
    expect(Math.hypot(...close[1]!)).toBeGreaterThan(15);
    expect(markOffsets([[71.40, 51.10], [71.42, 51.11]])).toEqual([[0, 0], [0, 0]]);
  });
});
