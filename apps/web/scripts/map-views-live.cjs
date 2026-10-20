// Real screenshots + rough rendering numbers from the running app (no mocks, no generated images).
// Usage: node scripts/map-views-live.cjs [baseUrl] [outDir] [label] [--perf-only] [--phone]
// --perf-only: only the camera-flight numbers (no screenshots, no recommendation request, so no model
// generation competes for the CPU); --phone: 390×844 at device pixel ratio 3 (touch, mobile).
// Views: city overview, Baiterek, EXPO (desktop 1440×900, 3D) and the mobile plan screen (390×844).
// Performance: frames during a fixed 6 s camera flight, at 1× and 4× CPU throttling (Chrome DevTools
// emulation; it does not emulate a phone GPU). Headless Chromium may render with a software GL
// (the renderer string is recorded) — compare runs on the same machine only.
const { chromium } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const base = process.argv[2] || "http://127.0.0.1:3208";
const out = path.resolve(process.argv[3] || "../../artifacts/map-realism/run");
const label = process.argv[4] || "run";
const perfOnly = process.argv.includes("--perf-only");
const phone = process.argv.includes("--phone");

const VIEWS = [
  { name: "city", center: [71.43, 51.135], zoom: 11.8, pitch: 35, bearing: 0 },
  { name: "baiterek", center: [71.4303, 51.1281], zoom: 17.2, pitch: 62, bearing: -35 },
  { name: "expo", center: [71.4159, 51.0897], zoom: 16.2, pitch: 58, bearing: -15 },
];

async function idle(page, timeout = 30000) {
  await page.waitForFunction(() => {
    const m = window.__smartcityMap;
    return m && m.loaded() && m.areTilesLoaded() && !m.isMoving();
  }, {}, { timeout, polling: 200 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function flight(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const m = window.__smartcityMap;
    m.jumpTo({ center: [71.418, 51.1], zoom: 13, pitch: 45, bearing: 0 });
    let frames = 0, worst = 0, last = performance.now();
    const t0 = last;
    const tick = (t) => {
      frames++; worst = Math.max(worst, t - last); last = t;
      if (t - t0 < 6000) requestAnimationFrame(tick);
      else resolve({ frames, seconds: (t - t0) / 1000, fps: +(frames / ((t - t0) / 1000)).toFixed(1), worstFrameMs: Math.round(worst) });
    };
    requestAnimationFrame(tick);
    m.easeTo({ center: [71.4303, 51.1281], zoom: 16.8, pitch: 60, bearing: -40, duration: 5800, essential: true });
  }));
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const evidence = { label, base, views: {}, perf: {} };
  const page = await browser.newPage(phone
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, locale: "ru-RU", timezoneId: "Asia/Almaty" }
    : { viewport: { width: 1440, height: 900 }, locale: "ru-RU", timezoneId: "Asia/Almaty" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const t0 = Date.now();
  await page.goto(base);
  await page.waitForFunction(() => window.__smartcity?.loaded === true, {}, { timeout: 60000 });
  await idle(page, 60000);
  evidence.firstIdleMs = Date.now() - t0;
  evidence.renderer = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  if (phone) await page.getByRole("button", { name: "Карта", exact: true }).click().catch(() => {});
  for (const v of perfOnly ? [] : VIEWS) {
    const s = Date.now();
    await page.evaluate((view) => window.__smartcityMap.jumpTo(view), v);
    await idle(page);
    const info = await page.evaluate(() => {
      const m = window.__smartcityMap;
      const layers = m.getStyle().layers.filter((l) => m.getLayoutProperty(l.id, "visibility") !== "none").length;
      const symbols = m.queryRenderedFeatures().filter((f) => f.layer.type === "symbol").length;
      return { layers, symbols, zoom: +m.getZoom().toFixed(2) };
    });
    evidence.views[v.name] = { ...info, toIdleMs: Date.now() - s };
    await page.screenshot({ path: path.join(out, `${label}-${v.name}.png`) });
  }
  const cdp = await page.context().newCDPSession(page);
  for (const rate of [1, 4]) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    evidence.perf[`cpu${rate}x`] = await flight(page);
    await idle(page, 60000);
  }
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  evidence.jsHeapMb = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));
  evidence.errors = errors;
  evidence.canvasPx = await page.evaluate(() => { const c = window.__smartcityMap.getCanvas(); return [c.width, c.height]; });
  await page.close();
  if (perfOnly) {
    await browser.close();
    fs.writeFileSync(path.join(out, `${label}.json`), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 1));
    return;
  }

  // Mobile: the real plan flow, then the map tab.
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: "ru-RU", timezoneId: "Asia/Almaty" });
  await m.goto(base);
  await m.getByRole("button", { name: /Демо-точка/ }).click();
  await m.getByRole("button", { name: "60 мин", exact: true }).click();
  await m.getByLabel("Что хочется").fill("Хочу погулять и посмотреть интересные места");
  await m.getByRole("button", { name: "Подобрать прогулку", exact: true }).click();
  await m.getByTestId("rec-card").first().waitFor({ timeout: 210000 });
  await m.getByRole("button", { name: "Карта", exact: true }).click();
  await m.waitForTimeout(400);
  await idle(m, 60000);
  await m.screenshot({ path: path.join(out, `${label}-mobile.png`) });
  evidence.mobilePlan = await m.getByTestId("walk-plan").count();
  await browser.close();
  fs.writeFileSync(path.join(out, `${label}.json`), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
