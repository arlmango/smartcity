// Screenshots of a running SmartCity web server (default dev :3001), e.g. rendering real OSM map layers
// served via WEB_DEV_MAP_DIR. Usage: node scripts/screenshot-map.mjs <outDir> [baseUrl]
import { chromium } from "@playwright/test";
const OUT = process.argv[2];
const BASE = process.argv[3] ?? "http://127.0.0.1:3001";
(async () => {
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  for (const [name, vp, mobile] of [["desktop-1440x900", { width: 1440, height: 900 }, false], ["mobile-390x844", { width: 390, height: 844 }, true]]) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1, locale: "ru-RU" });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && errs.push(m.text().slice(0, 200)));
    const t0 = Date.now();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__smartcity && window.__smartcity.loaded && (window.__smartcity.sourceCounts.buildings || 0) > 0, null, { timeout: 120000 });
    await page.evaluate(() => new Promise((r) => { window.__smartcityMap.once("idle", r); window.__smartcityMap.triggerRepaint(); setTimeout(r, 8000); }));
    const tReady = Date.now() - t0;
    const info = await page.evaluate(() => {
      const m = window.__smartcityMap;
      return {
        counts: window.__smartcity.sourceCounts,
        rendered3d: m.queryRenderedFeatures({ layers: ["buildings-3d", "buildings-3d-default"] }).length,
        roads: m.queryRenderedFeatures({ layers: ["roads"] }).length,
        labels: m.queryRenderedFeatures({ layers: ["road-labels"] }).length,
      };
    });
    console.log(name, "map-ready ms", tReady, JSON.stringify(info));
    await page.screenshot({ path: `${OUT}/${name}-01-initial-3d-REAL-osm-map-layers-no-api.png` });
    await page.getByTestId("toggle-3d").click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/${name}-02-2d-REAL-osm-map-layers-no-api.png` });
    await page.getByTestId("toggle-3d").click();
    await page.evaluate(() => window.__smartcityMap.jumpTo({ center: [71.4155, 51.0885], zoom: 16.3, pitch: 58, bearing: -20 }));
    await page.evaluate(() => new Promise((r) => { window.__smartcityMap.once("idle", r); setTimeout(r, 8000); }));
    await page.screenshot({ path: `${OUT}/${name}-03-3d-closeup-REAL-osm-map-layers-no-api.png` });
    console.log(name, "console:", JSON.stringify(errs.slice(0, 12)));
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
