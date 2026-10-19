// Live check of the timebox plan against a running local stack (real DB, real router, real model).
// Usage: node scripts/plan-live.cjs [baseUrl] [outDir] [--router-down]. Writes screenshots + JSON; no mocks.
// --router-down: run with the router stopped; records what a person sees (no plan, honest notes).
const { chromium } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const base = process.argv[2] || "http://127.0.0.1:3208";
const out = path.resolve(process.argv[3] || "../../artifacts/routing-cloud");
const query = "Хочу погулять и посмотреть интересные места";
const routerDown = process.argv.includes("--router-down");

async function routeFeatures(page) {
  return page.evaluate(async () => {
    const data = await window.__smartcityMap?.getSource("walking-route")?.getData();
    return data?.type === "FeatureCollection" ? data.features.length : null;
  });
}

async function settle(page) {
  await page.waitForFunction(() => window.__smartcityMap && !window.__smartcityMap.isMoving(), {}, { timeout: 15000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const evidence = { base, query, runs: [] };
  const viewports = [{ name: "mobile-390", width: 390, height: 844 }, { name: "mobile-360", width: 360, height: 800 },
    { name: "mobile-430", width: 430, height: 932 }, { name: "desktop", width: 1440, height: 900 }];
  for (const vp of routerDown ? viewports.slice(0, 1) : viewports) {
    const mobile = vp.name.startsWith("mobile");
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, locale: "ru-RU",
      isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1, timezoneId: "Asia/Almaty" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    await page.getByRole("button", { name: /Демо-точка/ }).click();
    await page.getByRole("button", { name: "60 мин", exact: true }).click();
    await page.getByLabel("Что хочется").fill(query);
    const t0 = Date.now();
    await page.getByRole("button", { name: "Подобрать прогулку", exact: true }).click();
    await page.getByTestId("rec-card").first().waitFor({ timeout: 210000 });
    const firstCardsMs = Date.now() - t0;
    const planShown = await page.getByTestId("walk-plan").count();
    const run = { viewport: vp.name, firstCardsMs, planShown, errors };
    if (planShown) {
      run.planText = await page.getByTestId("walk-plan").innerText();
      // The line source is filled once the style is idle: poll briefly before reading it.
      await page.waitForFunction(async () => {
        const d = await window.__smartcityMap?.getSource("walking-route")?.getData();
        return d?.type === "FeatureCollection" && d.features.length > 0;
      }, {}, { timeout: 15000 }).catch(() => {});
      run.planFeatures = await routeFeatures(page);
      run.planMarks = await page.getByTestId("plan-stop-mark").count();
      if (mobile) {
        await page.getByRole("button", { name: "Карта", exact: true }).click();
        await page.waitForFunction(() => window.__smartcityMap?.queryRenderedFeatures({ layers: ["walking-outbound"] }).length > 0, {}, { timeout: 15000 });
        await settle(page);
        await page.screenshot({ path: path.join(out, `plan-map-${vp.name}.png`) });
        await page.getByRole("button", { name: "Список", exact: true }).click();
      }
      await page.getByTestId("walk-plan").scrollIntoViewIfNeeded();
      await settle(page);
      await page.screenshot({ path: path.join(out, `plan-panel-${vp.name}.png`) });
    } else {
      run.planNote = await page.getByTestId("plan-note").innerText().catch(() => null);
      run.warnings = await page.getByRole("list", { name: "Предупреждения" }).innerText().catch(() => null);
      run.routeUnavailable = await page.getByTestId("route-unavailable").count();
      if (mobile) await page.getByRole("button", { name: "Список", exact: true }).click();
      await page.getByTestId("plan-note").scrollIntoViewIfNeeded().catch(() => {});
      await page.screenshot({ path: path.join(out, `${routerDown ? "router-down" : "no-plan"}-${vp.name}.png`) });
    }
    run.noHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    if (vp.name === "mobile-390" && !routerDown) {
      // Full answer, then "remove a stop": the plan is recomputed with that place excluded.
      await page.getByText("Места уже найдены поиском по базе — ИИ ещё готовит объяснения.").waitFor({ state: "hidden", timeout: 210000 });
      run.finalMs = Date.now() - t0;
      if (planShown) {
        const before = await page.getByTestId("plan-stop").allInnerTexts();
        const remove = page.getByRole("button", { name: /^Убрать остановку: / }).first();
        run.removed = (await remove.getAttribute("aria-label")).replace("Убрать остановку: ", "");
        const t1 = Date.now();
        await remove.click();
        await page.getByTestId("rec-card").first().waitFor({ timeout: 210000 });
        run.afterRemoveFirstCardsMs = Date.now() - t1;
        run.afterRemovePlan = await page.getByTestId("walk-plan").innerText().catch(() => null);
        run.afterRemoveNote = run.afterRemovePlan ? null : await page.getByTestId("plan-note").innerText().catch(() => null);
        run.removedStillInPlan = run.afterRemovePlan ? run.afterRemovePlan.includes(run.removed) : false;
        run.before = before;
        await settle(page);
        await page.screenshot({ path: path.join(out, `plan-after-remove-${vp.name}.png`) });
      }
    }
    evidence.runs.push(run);
    console.log(JSON.stringify(run));
    await page.close();
  }
  fs.writeFileSync(path.join(out, routerDown ? "router-down-live.json" : "plan-live.json"), JSON.stringify(evidence, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
