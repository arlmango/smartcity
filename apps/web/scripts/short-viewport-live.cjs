// Short-viewport emulation of an open on-screen keyboard (NOT a real phone): the submit button must stay
// reachable and uncovered, no horizontal overflow. Usage: node scripts/short-viewport-live.cjs (stack on :3208).
const { chromium } = require("@playwright/test");
(async () => {
  const b = await chromium.launch(); const out = [];
  for (const [w, h] of [[360, 400], [390, 460], [430, 500], [740, 360]]) {
    const p = await b.newPage({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, locale: "ru-RU" });
    await p.goto("http://127.0.0.1:3208");
    await p.getByRole("button", { name: /Демо-точка/ }).click();
    const field = p.getByLabel("Что хочется"); await field.focus(); await field.fill("кофе и парк");
    const btn = p.getByRole("button", { name: "Подобрать прогулку", exact: true });
    await btn.scrollIntoViewIfNeeded();
    const hit = await btn.evaluate((el) => { const r = el.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, onTop: !!e && (e === el || el.contains(e)) }; });
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    out.push({ viewport: `${w}x${h}`, ...hit, noHorizontalOverflow: overflow });
    await p.screenshot({ path: `../../artifacts/routing-cloud/short-viewport-${w}x${h}.png` });
    await p.close();
  }
  console.log(JSON.stringify(out, null, 1)); await b.close();
})();
