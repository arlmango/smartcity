/**
 * Procedural window patterns for fill-extrusion walls: a stylisation that hints at floors and glazing.
 * They are NOT photographs or surveyed facades of real buildings (the map legend says so).
 * Pure RGBA generation (no canvas), so it is cheap, deterministic and testable.
 */
import type { FacadeId } from "./mapStyle";

export const FACADE_SIZE = 32; // px; one tile = 4 × 4 window cells (≈ one floor per cell at street zoom)

const hex = (c: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number];

interface Spec {
  wall: string;
  glass: string;
  /** Window rectangle inside an 8×8 cell: x, y, w, h. */
  win: [number, number, number, number];
  /** Optional horizontal spandrel band (tower glazing). */
  band?: string;
}

const SPECS: Record<FacadeId, Spec> = {
  "sc-facade-low": { wall: "#EEE9DF", glass: "#A6B5BE", win: [2, 2, 4, 4] },
  "sc-facade-mid": { wall: "#EAE7E0", glass: "#93A6B3", win: [2, 1, 4, 5] },
  "sc-facade-tower": { wall: "#C9D7DF", glass: "#A3BACA", win: [1, 0, 7, 6], band: "#DCE4E9" },
};

export function facadeImage(id: FacadeId): { width: number; height: number; data: Uint8ClampedArray } {
  const s = SPECS[id];
  const n = FACADE_SIZE;
  const data = new Uint8ClampedArray(n * n * 4);
  const wall = hex(s.wall), glass = hex(s.glass), band = s.band ? hex(s.band) : null;
  const [wx, wy, ww, wh] = s.win;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const cx = x % 8, cy = y % 8;
      const inWin = cx >= wx && cx < wx + ww && cy >= wy && cy < wy + wh;
      const c = inWin ? glass : band && cy >= wy + wh ? band : wall;
      const o = (y * n + x) * 4;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
    }
  }
  return { width: n, height: n, data };
}
