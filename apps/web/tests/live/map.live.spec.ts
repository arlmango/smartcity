/**
 * LIVE: map with the real OSM snapshot served by the real API. No mocks.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { ART, collect, mapIdle, originFromSearch, shot, useDemoOrigin, waitForMap } from "./helpers";

test.describe("live: map on real data", () => {
  test.describe.configure({ timeout: 180_000 });
  test("initial load: real GeoJSON features, 3D extrusion, 2D/3D, north, zoom; no GPS on load @mobile @smoke", async ({ page, request }, info) => {
    const c = collect(page, info);
    await page.addInitScript(() => {
      (window as unknown as { __geoCalls: number }).__geoCalls = 0;
      const g = navigator.geolocation;
      if (g) {
        const orig = g.getCurrentPosition.bind(g);
        g.getCurrentPosition = (...a: Parameters<Geolocation["getCurrentPosition"]>) => {
          (window as unknown as { __geoCalls: number }).__geoCalls++;
          return orig(...a);
        };
      }
    });
    // Satellite host: never contacted before an explicit opt-in (and never in commercial mode).
    const thirdParty: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (!["127.0.0.1", "localhost"].includes(u.hostname) && !["data:", "blob:"].includes(u.protocol)) thirdParty.push(u.host);
    });
    const t0 = Date.now();
    await page.goto("/");
    await waitForMap(page);
    const mapReadyMs = Date.now() - t0;
    await mapIdle(page);
    await page.evaluate(() => window.__smartcityMap!.jumpTo({ zoom: 11.5 }));
    await mapIdle(page);
    await page.evaluate(() => window.__smartcityMap!.jumpTo({ zoom: 15 }));
    await mapIdle(page);
    expect(thirdParty, "requests to third-party hosts on first open").toEqual([]);
    expect(await page.evaluate(() => window.__smartcity!.variant)).toBe("scheme");

    // The coverage outline equals what the real API serves; the city comes from real vector tiles.
    const served: Record<string, number> = {};
    for (const layer of ["coverage"]) {
      const res = await request.get(`/api/map/${layer}`);
      expect(res.status()).toBe(200);
      served[layer] = ((await res.json()) as { features: unknown[] }).features.length;
    }
    const basemap = (await (await request.get("/api/basemap")).json()) as { buildings: number; coverage: { boundary_inside_tiles: boolean } };
    expect(basemap.buildings).toBeGreaterThan(50_000);
    expect(basemap.coverage.boundary_inside_tiles).toBe(true);
    const info3d = await page.evaluate(() => {
      const map = window.__smartcityMap!;
      const c = map.getCenter();
      return {
        counts: window.__smartcity!.sourceCounts,
        extrusionType: map.getLayer("buildings-3d")?.type,
        extrusionVisible: map.getLayoutProperty("buildings-3d", "visibility"),
        rendered3d: map.queryRenderedFeatures({ layers: ["buildings-3d", "buildings-3d-approx"] }).length,
        sampleHeightSources: Array.from(
          new Set(map.queryRenderedFeatures({ layers: ["buildings-3d", "buildings-3d-approx"] }).map((f) => f.properties?.src)),
        ),
        pitch: map.getPitch(),
        center: [c.lng, c.lat],
        geoCalls: (window as unknown as { __geoCalls: number }).__geoCalls,
      };
    });
    for (const k of Object.keys(served)) expect(info3d.counts[k], `source ${k}`).toBe(served[k]);
    expect(info3d.extrusionType).toBe("fill-extrusion");
    expect(info3d.extrusionVisible).toBe("visible");
    expect(info3d.rendered3d).toBeGreaterThan(50);
    expect(info3d.pitch).toBeGreaterThan(40);
    expect(info3d.center[0]).toBeCloseTo(71.414, 2);
    expect(info3d.center[1]).toBeCloseTo(51.089, 2);
    expect(info3d.geoCalls).toBe(0);
    await expect(page.getByTestId("height-legend")).toContainText("приблизительно");
    await shot(page, info, "01-initial-3d-map");

    // MEGA Silk Way and EXPO are rendered at their DB/OSM coordinates (projected inside the viewport, west→east order).
    const order = await page.evaluate(() => {
      const map = window.__smartcityMap!;
      return { mega: map.project([71.407447, 51.089071]).x, expo: map.project([71.421448, 51.092784]).x };
    });
    expect(order.mega).toBeLessThan(order.expo);

    // 2D/3D toggle
    const toggle = page.getByTestId("toggle-3d");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await page.waitForFunction(() => window.__smartcityMap!.getPitch() === 0, null, { timeout: 15_000 });
    const vis2d = await page.evaluate(() => ({
      ext: window.__smartcityMap!.getLayoutProperty("buildings-3d", "visibility"),
      flat: window.__smartcityMap!.getLayoutProperty("buildings-2d", "visibility"),
    }));
    expect(vis2d).toEqual({ ext: "none", flat: "visible" });
    await mapIdle(page);
    await shot(page, info, "02-2d-map");
    await toggle.click();
    await page.waitForFunction(() => window.__smartcityMap!.getPitch() > 40, null, { timeout: 15_000 });

    // Reset north
    await page.evaluate(() => window.__smartcityMap!.setBearing(70));
    await page.getByRole("button", { name: "На север" }).click();
    await page.waitForFunction(() => Math.abs(window.__smartcityMap!.getBearing()) < 0.5, null, { timeout: 15_000 });
    // Zoom +/−
    const z0 = await page.evaluate(() => window.__smartcityMap!.getZoom());
    await page.getByRole("button", { name: "Приблизить" }).click();
    await page.waitForFunction((z) => window.__smartcityMap!.getZoom() > z + 0.5, z0, { timeout: 15_000 });
    await page.getByRole("button", { name: "Отдалить" }).click();
    await page.waitForFunction((z) => Math.abs(window.__smartcityMap!.getZoom() - z) < 0.3, z0, { timeout: 15_000 });

    // Attribution visible and linked
    const attrib = page.locator(".maplibregl-ctrl-attrib a", { hasText: "© OpenStreetMap contributors" }).first();
    await expect(attrib).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");

    writeFileSync(
      path.join(ART, `map-${info.project.name}.json`),
      JSON.stringify({ project: info.project.name, mapReadyMs, served, ...info3d }, null, 2),
    );
    c.flush();
  });

  test("perf: cold vs warm load and map-ready (desktop)", async ({ browser }, info) => {
    test.skip(info.project.name !== "desktop-1440", "desktop only");
    const runs: Array<{ kind: string; domContentLoadedMs: number; loadMs: number; mapReadyMs: number }> = [];
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    let page = await ctx.newPage();
    for (const kind of ["cold", "warm", "warm", "warm"]) {
      if (kind === "warm") {
        await page.close();
        page = await ctx.newPage(); // new tab in the same context: HTTP cache is warm
      }
      const t0 = Date.now();
      await page.goto("/", { waitUntil: "load" });
      await waitForMap(page);
      const mapReadyMs = Date.now() - t0;
      const nav = await page.evaluate(() => {
        const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
        return { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) };
      });
      runs.push({ kind, domContentLoadedMs: nav.dcl, loadMs: nav.load, mapReadyMs });
    }
    await ctx.close();
    writeFileSync(path.join(ART, "perf-page-load.json"), JSON.stringify({ method: "Playwright Chromium headless (SwiftShader WebGL), same host as stack, 1 context; cold = first navigation of a fresh context, warm = new tab in the same context (HTTP cache warm, JS heap fresh)", runs }, null, 2));
  });

  test("pick origin by clicking the map; outside coverage is refused @mobile", async ({ page }, info) => {
    const c = collect(page, info);
    await page.goto("/");
    await waitForMap(page);
    // Without an origin the map is already in pick mode ("Выбираем…").
    await expect(page.getByRole("button", { name: "Выбираем…" })).toBeVisible();
    const canvas = page.locator(".maplibregl-canvas");
    await page.evaluate(() => window.__smartcityMap!.jumpTo({ center: [71.414, 51.089], zoom: 15, pitch: 0 }));
    await mapIdle(page);
    const pt = await page.evaluate(() => {
      const p = window.__smartcityMap!.project([71.414, 51.089]);
      return { x: p.x, y: p.y };
    });
    await canvas.click({ position: pt });
    await expect(page.getByTestId("origin-label")).toHaveText("Точка на карте");
    await expect(page.getByTestId("origin-marker")).toBeVisible();

    await page.getByRole("button", { name: "На карте" }).click();
    await page.evaluate(() => window.__smartcityMap!.jumpTo({ center: [71.45, 51.095], zoom: 13, pitch: 0 }));
    await mapIdle(page);
    const out = await page.evaluate(() => {
      const p = window.__smartcityMap!.project([71.452, 51.095]); // east of the coverage polygon (maxlon 71.445)
      return { x: p.x, y: p.y };
    });
    await canvas.click({ position: out });
    const alert = page.getByRole("alert").filter({ has: page.getByRole("button", { name: "Показать зону" }) });
    await expect(alert).toContainText("Вне зоны рекомендаций");
    await expect(page.getByText(/Карта показывает всю Астану/)).toBeVisible();
    await expect(page.getByTestId("origin-label")).toHaveText("Точка на карте");
    await shot(page, info, "03-outside-coverage-click");
    await alert.getByRole("button", { name: "Показать зону" }).click();
    await page.waitForFunction(() => {
      const m = window.__smartcityMap!;
      const c = m.getCenter();
      return !m.isMoving() && Math.abs(c.lng - 71.42) < 0.03 && Math.abs(c.lat - 51.09) < 0.03;
    });
    c.flush();
  });

  test("geolocation denied (no permission) does not block the form @mobile", async ({ page }, info) => {
    const c = collect(page, info);
    await page.goto("/");
    await page.getByRole("button", { name: "Моё местоположение" }).click();
    await expect(page.getByText(/Браузер спросит разрешение/)).toBeVisible();
    await page.getByRole("button", { name: "Разрешить запрос" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /не разрешён|Не удалось определить|запрещ/ })).toBeVisible({ timeout: 20_000 });
    await shot(page, info, "04-geolocation-denied");
    await useDemoOrigin(page);
    await expect(page.getByRole("button", { name: "Подобрать прогулку" })).toBeEnabled();
    c.flush();
  });

  test("place search over our own DB: Mega, Starbucks, nonsense", async ({ page }, info) => {
    const c = collect(page, info);
    await page.goto("/");
    await originFromSearch(page, "Mega", "Mega Silk Way");
    await page.getByLabel("Найти место в нашей базе").fill("Starbucks");
    const list = page.getByRole("list", { name: "Результаты поиска" });
    await expect(list.getByRole("button").first()).toBeVisible({ timeout: 20_000 });
    const names = await list.getByRole("button").allTextContents();
    writeFileSync(path.join(ART, "search-starbucks.json"), JSON.stringify(names, null, 2));
    await page.getByLabel("Найти место в нашей базе").fill("zzzqqq-нет-такого");
    await expect(page.getByText("Ничего не найдено в собранной базе района.")).toBeVisible({ timeout: 20_000 });
    c.flush();
  });

  test("axe on the live initial page @mobile", async ({ page }, info) => {
    await page.goto("/");
    await waitForMap(page);
    const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    writeFileSync(path.join(ART, `axe-initial-${info.project.name}.json`), JSON.stringify(res.violations, null, 2));
    const bad = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });

  test("keyboard: tab order form → map controls, focus-visible", async ({ page }) => {
    await page.goto("/");
    await waitForMap(page);
    await useDemoOrigin(page); // submit is disabled (not focusable) until an origin exists
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const order: string[] = [];
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press("Tab");
      const d = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const ring = (e: Element | null) => {
          if (!e) return false;
          const cs = getComputedStyle(e);
          return (cs.outlineStyle !== "none" && cs.outlineWidth !== "0px") || (cs.boxShadow !== "none" && cs.boxShadow !== "");
        };
        // sr-only switch inputs draw the ring on their visual peer (next sibling).
        const visible = ring(el) && !el.classList.contains("sr-only") ? true : ring(el.nextElementSibling) || ring(el);
        return {
          label: (
            el.getAttribute("aria-label") ||
            (el as HTMLInputElement).labels?.[0]?.textContent ||
            el.textContent ||
            el.tagName
          )
            .trim()
            .slice(0, 50),
          outline: visible,
          inMap: !!el.closest('[aria-label="Карта"]'),
        };
      });
      if (!d) continue;
      order.push(`${d.inMap ? "[map] " : ""}${d.label}${d.outline ? "" : " (NO FOCUS RING)"}`);
    }
    writeFileSync(path.join(ART, "keyboard-tab-order-desktop.json"), JSON.stringify(order, null, 2));
    const firstMap = order.findIndex((s) => s.startsWith("[map]"));
    const submitIdx = order.findIndex((s) => /Подобрать прогулку/.test(s));
    expect(submitIdx).toBeGreaterThan(-1);
    expect(firstMap).toBeGreaterThan(submitIdx);
    expect(order.filter((s) => s.includes("NO FOCUS RING"))).toEqual([]);
  });

  test("reduced motion: camera jumps instead of animating", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto("/");
    await waitForMap(page);
    const reduced = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    expect(reduced).toBe(true);
    await page.evaluate(() => window.__smartcityMap!.setBearing(70));
    await page.getByRole("button", { name: "На север" }).click();
    // With reduced motion the reset is immediate (jumpTo), not a 300+ ms animation.
    await page.waitForTimeout(100);
    const b = await page.evaluate(() => window.__smartcityMap!.getBearing());
    expect(Math.abs(b)).toBeLessThan(0.5);
    await ctx.close();
  });
});
