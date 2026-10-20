import { expect, test } from "@playwright/test";
import { basemapInfo, mapIdle, mockApi, waitForMap } from "./helpers";

// SYNTHETIC API and tiles. Checks the wiring: building source switch, landmark models, honest legend,
// detail tier. Real rendering is shown by artifacts/map-realism (screenshots from the running app).
test("without own building tiles: no /tiles/buildings requests, landmark models drawn, honest legend @mobile", async ({ page }, testInfo) => {
  const api = await mockApi(page, { basemap: { ...basemapInfo(false), building_tiles: "base", height_source: { height: 0, levels: 0, estimate: 0, default: 0 }, stylised_landmarks: [] } });
  await page.goto("/");
  await waitForMap(page);
  await page.evaluate(() => window.__smartcityMap!.jumpTo({ center: [71.4304, 51.1283], zoom: 16.5, pitch: 60 }));
  await mapIdle(page);
  const info = await page.evaluate(() => {
    const m = window.__smartcityMap!;
    return {
      hasBuildingsSource: !!m.getSource("buildings"),
      solidSource: m.getLayer("buildings-3d")?.source,
      landmarkPieces: m.queryRenderedFeatures({ layers: ["landmarks-3d"] }).length,
      facadeLayer: !!m.getLayer("buildings-3d-facade"),
    };
  });
  expect(info.hasBuildingsSource).toBe(false);
  expect(info.solidSource).toBe("base");
  expect(info.landmarkPieces).toBeGreaterThan(5);
  expect(api.tiles.filter((t) => t.includes("/buildings/"))).toEqual([]);
  // Phones (coarse pointer, few cores) get the light tier: no procedural facades.
  expect(info.facadeLayer).toBe(!testInfo.project.name.startsWith("mobile"));
  const legend = page.getByTestId("height-legend");
  await legend.locator("summary").click();
  await expect(legend).toContainText("Высота из OSM (height или этажи)");
  await expect(legend).toContainText("условно 10 м");
  await expect(legend).toContainText("Байтерек и Нур Алем — упрощённые модели");
});

test("?detail=low forces the light tier; ?detail=high the full one", async ({ page }) => {
  await mockApi(page);
  await page.goto("/?detail=low");
  await waitForMap(page);
  expect(await page.evaluate(() => !!window.__smartcityMap!.getLayer("buildings-3d-facade"))).toBe(false);
  await page.goto("/?detail=high");
  await waitForMap(page);
  expect(await page.evaluate(() => !!window.__smartcityMap!.getLayer("buildings-3d-facade"))).toBe(true);
});
