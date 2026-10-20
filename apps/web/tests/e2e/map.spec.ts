import { expect, test } from "@playwright/test";
import { mapIdle, mockApi, waitForMap } from "./helpers";

test.describe("deterministic: map (SYNTHETIC fixtures and tiles)", () => {
  test("loads city vector tiles for the visible area only, with 3D extrusion @mobile @xbrowser", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.addInitScript(() => {
      (window as unknown as { __geoCalls: number }).__geoCalls = 0;
      const orig = navigator.geolocation?.getCurrentPosition?.bind(navigator.geolocation);
      if (orig)
        navigator.geolocation.getCurrentPosition = (...a: Parameters<Geolocation["getCurrentPosition"]>) => {
          (window as unknown as { __geoCalls: number }).__geoCalls++;
          return orig(...a);
        };
    });
    const external: string[] = [];
    page.on("request", (r) => !r.url().startsWith("http://127.0.0.1") && !r.url().startsWith("data:") && !r.url().startsWith("blob:") && external.push(r.url()));
    const api = await mockApi(page);
    await page.goto("/");
    await expect(page.getByText("SmartCity", { exact: true })).toBeVisible();
    await waitForMap(page);
    await mapIdle(page);

    const info = await page.evaluate(() => {
      const map = window.__smartcityMap!;
      const center = map.getCenter();
      return {
        counts: window.__smartcity!.sourceCounts,
        variant: window.__smartcity!.variant,
        hasExtrusion: map.getLayer("buildings-3d")?.type,
        extrusionVisible: map.getLayoutProperty("buildings-3d", "visibility"),
        rendered3d: map.queryRenderedFeatures({ layers: ["buildings-3d", "buildings-3d-approx"] }).length,
        pitch: map.getPitch(),
        center: [center.lng, center.lat],
        geoCalls: (window as unknown as { __geoCalls: number }).__geoCalls,
        hasSatellite: !!map.getSource("satellite"),
      };
    });
    expect(info.counts.coverage).toBe(1);
    expect(info.counts.boundary).toBe(1);
    expect(info.hasExtrusion).toBe("fill-extrusion");
    expect(info.extrusionVisible).toBe("visible");
    expect(info.rendered3d).toBeGreaterThan(0);
    expect(info.pitch).toBeGreaterThan(40);
    // Satellite disabled by the API (commercial mode in this mock) → scheme, no EOX request at all.
    expect(info.variant).toBe("scheme");
    expect(info.hasSatellite).toBe(false);
    expect(external).toEqual([]);
    // Initial camera is the EXPO/MEGA area, not the user's position; GPS never requested on load.
    expect(info.center[0]).toBeCloseTo(71.414, 2);
    expect(info.center[1]).toBeCloseTo(51.089, 2);
    expect(info.geoCalls).toBe(0);

    // Viewport loading: only tiles around the view, buildings only from z13; no city-wide GeoJSON.
    const zooms = api.tiles.map((t) => Number(t.split("/")[1]));
    expect(api.tiles.length).toBeGreaterThan(0);
    expect(api.tiles.length).toBeLessThan(80);
    expect(Math.max(...zooms)).toBeLessThanOrEqual(15);
    expect(api.tiles.filter((t) => t.startsWith("buildings/")).every((t) => Number(t.split("/")[1]) >= 13)).toBe(true);
    expect(api.mapLayerRequests).toEqual(["coverage"]);
    // Tile URLs carry the archive version from /api/basemap (cache key that changes on rebuild).
    expect(api.tileQueries.every((q) => q === "?v=e2e0001")).toBe(true);

    // Roads, parks and water from the base tiles are actually rendered (SYNTHETIC fixture area).
    const renderedAt = async (center: [number, number], layer: string) => {
      await page.evaluate((c) => window.__smartcityMap!.jumpTo({ center: c, zoom: 15, pitch: 0, bearing: 0 }), center);
      await mapIdle(page);
      return page.evaluate((l) => window.__smartcityMap!.queryRenderedFeatures({ layers: [l] }).length, layer);
    };
    expect(await renderedAt([71.414, 51.089], "roads")).toBeGreaterThan(0);
    expect(await renderedAt([71.418, 51.092], "landuse-green")).toBeGreaterThan(0);
    expect(await renderedAt([71.4042, 51.094], "water")).toBeGreaterThan(0);

    // Attribution and scale are visible and not covered.
    const attrib = page.locator(".maplibregl-ctrl-attrib a", { hasText: "© OpenStreetMap contributors" });
    await expect(attrib).toBeVisible();
    await expect(attrib).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
    const box = (await attrib.boundingBox())!;
    const topEl = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x!, y!)?.closest(".maplibregl-ctrl-attrib") !== null,
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(topEl).toBe(true);
    await expect(page.locator(".maplibregl-ctrl-scale")).toBeVisible();
    expect(api.unmocked).toEqual([]);
    expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
  });

  test("2D/3D toggle, north reset, height legend and stylised landmark label @xbrowser", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await waitForMap(page);
    const legend = page.getByTestId("height-legend");
    await expect(legend).toContainText("условно 10 м");
    await expect(legend).toContainText("по типу или площади");
    await expect(legend).toContainText("Оценки — светлые, полупрозрачные");
    await expect(legend).toContainText("стилизация");
    const toggle = page.getByTestId("toggle-3d");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await page.waitForFunction(() => window.__smartcityMap!.getPitch() === 0);
    const vis2d = await page.evaluate(() => ({
      ext: window.__smartcityMap!.getLayoutProperty("buildings-3d", "visibility"),
      approx: window.__smartcityMap!.getLayoutProperty("buildings-3d-approx", "visibility"),
      flat: window.__smartcityMap!.getLayoutProperty("buildings-2d", "visibility"),
    }));
    expect(vis2d).toEqual({ ext: "none", approx: "none", flat: "visible" });
    await toggle.click();
    await page.waitForFunction(() => window.__smartcityMap!.getPitch() > 40);

    await page.evaluate(() => window.__smartcityMap!.jumpTo({ center: [71.416, 51.0894], zoom: 16.5 }));
    await mapIdle(page);
    // The old curated stylisation in tiles without `oid` yields to the landmark model and its label.
    const labels = await page.evaluate(() => ({
      stylised: window.__smartcityMap!.queryRenderedFeatures({ layers: ["stylised-labels"] }).map((f) => f.properties?.lbl),
      models: window.__smartcityMap!.queryRenderedFeatures({ layers: ["landmark-labels"] }).map((f) => f.properties?.lbl),
    }));
    expect(labels.stylised).not.toContain("SYNTH-сфера · стилизация");
    expect(labels.models).toContain("Нур Алем · стилизация");

    await page.evaluate(() => window.__smartcityMap!.setBearing(70));
    await page.getByRole("button", { name: "На север" }).click();
    await page.waitForFunction(() => Math.abs(window.__smartcityMap!.getBearing()) < 0.5);

    const z0 = await page.evaluate(() => window.__smartcityMap!.getZoom());
    await page.getByRole("button", { name: "Приблизить" }).click();
    await page.waitForFunction((z) => window.__smartcityMap!.getZoom() > z + 0.5, z0);
  });

  test("select origin by clicking the map; outside the recommendation zone is refused and the zone shown @xbrowser", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await waitForMap(page);
    const canvas = page.locator(".maplibregl-canvas");
    const pt = await page.evaluate(() => {
      const p = window.__smartcityMap!.project([71.413, 51.0885]);
      return { x: p.x, y: p.y };
    });
    await canvas.click({ position: pt });
    await expect(page.getByTestId("origin-label")).toHaveText("Точка на карте");
    await expect(page.getByTestId("origin-marker")).toBeVisible();

    await page.getByRole("button", { name: "На карте" }).click();
    await page.evaluate(() => window.__smartcityMap!.jumpTo({ center: [71.44, 51.12], zoom: 13, pitch: 0 }));
    const out = await page.evaluate(() => {
      const p = window.__smartcityMap!.project([71.45, 51.125]);
      return { x: p.x, y: p.y };
    });
    await canvas.click({ position: out });
    const alert = page.getByRole("alert").filter({ has: page.getByRole("button", { name: "Показать зону" }) });
    await expect(alert).toContainText("Вне зоны рекомендаций");
    await expect(alert).toBeVisible();
    await expect(page.getByText(/Карта показывает всю Астану/)).toBeVisible();
    await expect(page.getByTestId("origin-label")).toHaveText("Точка на карте"); // unchanged
    await alert.getByRole("button", { name: "Показать зону" }).click();
    await page.waitForFunction(() => {
      const c = window.__smartcityMap!.getCenter();
      return Math.abs(c.lng - 71.414) < 0.01 && Math.abs(c.lat - 51.09) < 0.01 && !window.__smartcityMap!.isMoving();
    });
  });

  test("failures are explicit, not an empty canvas", async ({ page }) => {
    await mockApi(page, { mapLayers: { coverage: 503 }, basemap: 503 });
    await page.goto("/");
    await expect(page.getByRole("alert").filter({ hasText: "Не удалось загрузить данные карты" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "Базовая карта города недоступна" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Повторить" }).first()).toBeVisible();
  });
});
