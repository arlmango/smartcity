// Copies the MapLibre GL 6 module worker into public/ so it is served same-origin
// (worker-src 'self' under our CSP). Run after upgrading maplibre-gl; a unit test fails on drift.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const dist = path.dirname(require.resolve("maplibre-gl/dist/maplibre-gl.mjs"));
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "public", "maplibre");
mkdirSync(outDir, { recursive: true });
copyFileSync(path.join(dist, "maplibre-gl-worker.mjs"), path.join(outDir, "maplibre-gl-worker.mjs"));
console.log("copied maplibre-gl-worker.mjs ->", outDir);
