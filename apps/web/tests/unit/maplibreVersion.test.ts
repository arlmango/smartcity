import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAPLIBRE_WORKER_URL } from "@/lib/mapWorker";

const require = createRequire(import.meta.url);
const pkgPath = require.resolve("maplibre-gl/package.json");
const version: string = JSON.parse(readFileSync(pkgPath, "utf8")).version;

function atLeast(v: string, min: [number, number, number]): boolean {
  const parts = v.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts[i]! !== min[i]) return parts[i]! > min[i]!;
  }
  return true;
}

describe("maplibre-gl security baseline", () => {
  it("GHSA-jrc7-96c5-q579 (DOM.sanitize bypass): installed maplibre-gl is >= 6.4.1", () => {
    expect(atLeast(version, [6, 4, 1])).toBe(true);
  });

  it("the same-origin worker file matches the installed maplibre-gl build (no stale copy)", () => {
    const shipped = readFileSync(path.join(__dirname, "../../public", MAPLIBRE_WORKER_URL));
    const installed = readFileSync(path.join(path.dirname(pkgPath), "dist", "maplibre-gl-worker.mjs"));
    expect(shipped.equals(installed)).toBe(true);
    expect(shipped.toString("utf8", 0, 300)).toContain(`v${version}`);
  });
});
