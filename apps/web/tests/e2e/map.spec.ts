import { expect, test } from "@playwright/test";
import { mapIdle, mockApi, waitForMap } from "./helpers";

test.describe("deterministic: map (SYNTHETIC fixtures)", () => {
  test("loads, initialises MapLibre with own GeoJSON sources and 3D extrusion @mobile", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    const geoCalls = await page.addInitScript(() => {
      (window as unknown as { __geoCalls: number }).__geoCalls = 0;
      const orig = navigator.geolocation?.getCurrentPosition?.bind(navigator.geolocation);
      if (orig)
        navigator.geolocation.getCurrentPosition = (...a: Parameters<Geolocation["getCurrentPosition"]>) => {
          (window as unknown as { __geoCalls: number }).__geoCalls++;
          return orig(...a);
        };
    });
    void geoCalls;
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
        hasExtrusion: map.getLayer("buildings-3d")?.type,
        extrusionVisible: map.getLayoutProperty("buildings-3d", "visibility"),
        rendered3d: map.queryRenderedFeatures({ layers: ["buildings-3d", "buildings-3d-default"] }).length,
        pitch: map.getPitch(),
        center: [center.lng, center.lat],
        geoCalls: (window as unknown as { __geoCalls: number }).__geoCalls,
      };
    });
    expect(info.counts.buildings).toBe(31);
    expect(info.counts.roads).toBe(3);
    expect(info.counts.green).toBe(1);
    expect(info.counts.water).toBe(1);
    expect(info.counts.coverage).toBe(1);
    expect(info.hasExtrusion).toBe("fill-extrusion");
    expect(info.extrusionVisible).toBe("visible");
    expect(info.rendered3d).toBeGreaterThan(0);
    expect(info.pitch).toBeGreaterThan(40);
    // Initial camera is the EXPO/MEGA area, not the user's position; GPS never requested on load.
    expect(info.center[0]).toBeCloseTo(71.414, 2);
    expect(info.center[1]).toBeCloseTo(51.089, 2);
    expect(info.geoCalls).toBe(0);

    // Roads/green/water are actually rendered (top-down overview of the fixture area).
    await page.evaluate(() => window.__smartcityMap!.jumpTo({ zoom: 14, pitch: 0 }));
    await mapIdle(page);
    const flat = await page.evaluate(() => {
      const map = window.__smartcityMap!;
      return {
        roads: map.queryRenderedFeatures({ layers: ["roads", "roads-paths"] }).length,
        green: map.queryRenderedFeatures({ layers: ["green-fill"] }).length,
      };
    });
    await page.evaluate(() => window.__smartcityMap!.jumpTo({ center: [71.4042, 51.094], zoom: 16, pitch: 0 }));
    await mapIdle(page);
    const water = await page.evaluate(() => window.__smartcityMap!.queryRenderedFeatures({ layers: ["water-fill"] }).length);
    expect(flat.roads).toBeGreaterThan(0);
    expect(flat.green).toBeGreaterThan(0);
    expect(water).toBeGreaterThan(0);

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

  test("2D/3D toggle, north reset and height legend", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await waitForMap(page);
    await expect(page.getByTestId("height-legend")).toContainText("условно 10 м");
    const toggle = page.getByTestId("toggle-3d");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await page.waitForFunction(() => window.__smartcityMap!.getPitch() === 0);
    const vis2d = await page.evaluate(() => ({
      ext: window.__smartcityMap!.getLayoutProperty("buildings-3d", "visibility"),
      flat: window.__smartcityMap!.getLayoutProperty("buildings-2d", "visibility"),
    }));
    expect(vis2d).toEqual({ ext: "none", flat: "visible" });
    await toggle.click();
    await page.waitForFunction(() => window.__smartcityMap!.getPitch() > 40);

    await page.evaluate(() => window.__smartcityMap!.setBearing(70));
    await page.getByRole("button", { name: "На север" }).click();
    await page.waitForFunction(() => Math.abs(window.__smartcityMap!.getBearing()) < 0.5);

    const z0 = await page.evaluate(() => window.__smartcityMap!.getZoom());
    await page.getByRole("button", { name: "Приблизить" }).click();
    await page.waitForFunction((z) => window.__smartcityMap!.getZoom() > z + 0.5, z0);
  });

  test("select origin by clicking the map; outside coverage is refused", async ({ page }) => {
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
    await page.evaluate(() => window.__smartcityMap!.jumpTo({ zoom: 13, pitch: 0 }));
    const out = await page.evaluate(() => {
      const p = window.__smartcityMap!.project([71.44, 51.103]);
      return { x: p.x, y: p.y };
    });
    await canvas.click({ position: out });
    await expect(page.getByText("Вне зоны покрытия данных", { exact: true })).toBeVisible();
    await expect(page.getByTestId("origin-label")).toHaveText("Точка на карте"); // unchanged
  });

  test("map layer failure shows an explicit error, not an empty canvas", async ({ page }) => {
    await mockApi(page, { mapLayers: { roads: 503 } });
    await page.goto("/");
    await expect(page.getByRole("alert").filter({ hasText: "Не загрузились слои карты: roads" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Повторить" })).toBeVisible();
  });
});
