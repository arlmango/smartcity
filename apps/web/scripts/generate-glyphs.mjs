#!/usr/bin/env node
/**
 * Generates MapLibre glyph PBFs (SDF, 24px, buffer 3) from the self-hosted Manrope
 * font (SIL OFL 1.1, @fontsource/manrope) into public/fonts/<stack>/<range>.pbf.
 *
 * Why: street/park labels are MapLibre symbol layers and need glyphs. We do not
 * want an external glyph CDN, and Cyrillic + Kazakh letters must render.
 *
 * How: renders each code point in headless Chromium with @mapbox/tiny-sdf (the same
 * SDF algorithm MapLibre uses for local glyphs) and encodes the glyphs protobuf in Node.
 * Code points outside Manrope's subsets are omitted (MapLibre then skips them).
 * All 256 ranges are written (most are empty) so MapLibre never hits a 404.
 *
 * Usage: pnpm glyphs   (needs Chromium; set CHROMIUM_PATH or PLAYWRIGHT_BROWSERS_PATH)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fontDir = path.join(root, "node_modules/@fontsource/manrope/files");
const unicode = JSON.parse(readFileSync(path.join(root, "node_modules/@fontsource/manrope/unicode.json"), "utf8"));
const tinySdfSrc = readFileSync(path.join(root, "node_modules/@mapbox/tiny-sdf/index.js"), "utf8").replace(
  "export default class TinySDF",
  "window.TinySDF = class TinySDF",
);

const STACKS = [{ name: "Manrope-Regular", weight: 400 }];
const SUBSETS = ["latin", "latin-ext", "cyrillic", "cyrillic-ext"];

function parseRanges(spec) {
  return spec.split(",").map((part) => {
    const [a, b] = part.replace("U+", "").split("-");
    const lo = parseInt(a, 16);
    return [lo, b ? parseInt(b, 16) : lo];
  });
}
const covered = SUBSETS.flatMap((s) => parseRanges(unicode[s]));
const isCovered = (cp) => covered.some(([lo, hi]) => cp >= lo && cp <= hi);

// ---------------------------------------------------------------- protobuf encoding
function varint(n, out) {
  let v = n >>> 0;
  while (v > 127) {
    out.push((v & 127) | 128);
    v >>>= 7;
  }
  out.push(v);
}
const zigzag = (n) => ((n << 1) ^ (n >> 31)) >>> 0;
function key(field, wire, out) {
  varint((field << 3) | wire, out);
}
function bytesField(field, bytes, out) {
  key(field, 2, out);
  varint(bytes.length, out);
  for (const b of bytes) out.push(b);
}
const utf8 = (s) => Array.from(Buffer.from(s, "utf8"));

function encodeGlyph(g) {
  const out = [];
  key(1, 0, out);
  varint(g.id, out);
  if (g.bitmap.length) bytesField(2, g.bitmap, out);
  key(3, 0, out);
  varint(g.width, out);
  key(4, 0, out);
  varint(g.height, out);
  key(5, 0, out);
  varint(zigzag(g.left), out);
  key(6, 0, out);
  varint(zigzag(g.top), out);
  key(7, 0, out);
  varint(g.advance, out);
  return out;
}

function encodeRange(stack, start, glyphs) {
  const fs = [];
  bytesField(1, utf8(stack), fs);
  bytesField(2, utf8(`${start}-${start + 255}`), fs);
  for (const g of glyphs) bytesField(3, encodeGlyph(g), fs);
  const out = [];
  bytesField(1, fs, out);
  return Buffer.from(out);
}

// ---------------------------------------------------------------- render in Chromium
const browserPath =
  process.env.CHROMIUM_PATH ??
  (process.env.PLAYWRIGHT_BROWSERS_PATH
    ? path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium-1194/chrome-linux/chrome")
    : undefined);
const browser = await chromium.launch(browserPath && existsSync(browserPath) ? { executablePath: browserPath } : {});
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ content: tinySdfSrc });

for (const stack of STACKS) {
  const faces = SUBSETS.map((s) => ({
    data: readFileSync(path.join(fontDir, `manrope-${s}-${stack.weight}-normal.woff2`)).toString("base64"),
    range: unicode[s],
  }));
  await page.evaluate(async ({ faces, weight }) => {
    for (const f of faces) {
      const face = new FontFace("SCGlyph", `url(data:font/woff2;base64,${f.data})`, { weight: String(weight), unicodeRange: f.range });
      await face.load();
      document.fonts.add(face);
    }
  }, { faces, weight: stack.weight });

  const outDir = path.join(root, "public/fonts", stack.name);
  mkdirSync(outDir, { recursive: true });
  let total = 0;
  for (let start = 0; start < 65536; start += 256) {
    const cps = [];
    for (let cp = start; cp < start + 256; cp++) {
      if (cp < 32 || (cp >= 127 && cp < 160)) continue; // control characters
      if (isCovered(cp)) cps.push(cp);
    }
    const glyphs = cps.length
      ? await page.evaluate(({ cps, weight }) => {
          const sdf = new window.TinySDF({ fontSize: 24, buffer: 3, radius: 8, cutoff: 0.25, fontFamily: "SCGlyph", fontWeight: String(weight) });
          return cps.map((id) => {
            const g = sdf.draw(String.fromCodePoint(id));
            return {
              id,
              bitmap: g.glyphWidth && g.glyphHeight ? Array.from(g.data) : [],
              width: g.glyphWidth,
              height: g.glyphHeight,
              left: g.glyphLeft,
              top: g.glyphTop - 27,
              advance: Math.round(g.glyphAdvance),
            };
          });
        }, { cps, weight: stack.weight })
      : [];
    total += glyphs.length;
    writeFileSync(path.join(outDir, `${start}-${start + 255}.pbf`), encodeRange(stack.name, start, glyphs));
  }
  console.log(`${stack.name}: ${total} glyphs → ${path.relative(root, outDir)}`);
}
await browser.close();
