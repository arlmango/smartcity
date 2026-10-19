import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { basemapInfo, mapIdle, mockApi, waitForMap } from "./helpers";

/**
 * Privacy/licence contract of the satellite underlay (EOxCloudless, third-party host):
 * no request to tiles.maps.eox.at before the viewer explicitly enables the hybrid after the notice;
 * never in commercial mode; the scheme keeps working when the satellite is unavailable.
 */
const EOX = /^https:\/\/tiles\.maps\.eox\.at\//;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/**
 * Every request the page attempts to EOX (counted even if it would fail), plus any EOX load that a
 * Content-Security-Policy blocked before it became a request — so "zero requests" cannot pass silently.
 */
async function watchEox(page: Page, mode: "ok" | "fail" = "ok"): Promise<string[]> {
  const seen: string[] = [];
  page.on("request", (r) => EOX.test(r.url()) && seen.push(r.url()));
  await page.exposeFunction("__eoxCsp", (u: string) => seen.push(`csp-blocked:${u}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      if (/eox\.at/.test(e.blockedURI)) (window as unknown as { __eoxCsp: (u: string) => void }).__eoxCsp(e.blockedURI);
    });
  });
  await page.route(EOX, (r) => (mode === "ok" ? r.fulfill({ status: 200, contentType: "image/png", body: PNG }) : r.abort("connectionrefused")));
  return seen;
}

/** City-scale view, where the hybrid (if it were on) would load satellite tiles. */
async function cityView(page: Page) {
  await page.evaluate(() => window.__smartcityMap!.jumpTo({ center: [71.414, 51.09], zoom: 12, pitch: 0, bearing: 0 }));
  await mapIdle(page);
}

/** The map credit is not covered by any control: every corner of it hit-tests to the credit itself. */
async function expectAttributionUncovered(page: Page) {
  const covered = await page.evaluate(() => {
    const a = document.querySelector(".maplibregl-ctrl-attrib")!;
    const r = a.getBoundingClientRect();
    const pts = [
      [r.left + 3, r.top + 3],
      [r.right - 3, r.top + 3],
      [r.left + 3, r.bottom - 3],
      [r.right - 3, r.bottom - 3],
      [(r.left + r.right) / 2, (r.top + r.bottom) / 2],
    ];
    return pts.filter(([x, y]) => !a.contains(document.elementFromPoint(x!, y!))).map(([x, y]) => `${Math.round(x!)},${Math.round(y!)}`);
  });
  expect(covered, "attribution points covered by another element").toEqual([]);
}

const hybridButton = (page: Page) => page.getByTestId("basemap-switch").getByRole("button", { name: "Гибрид" });

test.describe("satellite underlay: explicit opt-in only (SYNTHETIC API, EOX intercepted)", () => {
  test("commercial mode: no switch, no EOX request at any zoom @mobile @xbrowser", async ({ page }) => {
    const eox = await watchEox(page);
    await mockApi(page, { basemap: basemapInfo(false) });
    await page.goto("/");
    await waitForMap(page);
    await cityView(page);
    await expect(page.getByTestId("basemap-switch")).toHaveCount(0);
    await expect(page.getByTestId("basemap-toggle")).toHaveCount(0);
    expect(await page.evaluate(() => !!window.__smartcityMap!.getSource("satellite"))).toBe(false);
    await page.getByRole("button", { name: "О данных" }).click();
    await expect(page.getByRole("dialog", { name: "О данных" })).toContainText("запросов к EOX нет");
    expect(eox).toEqual([]);
  });

  test("noncommercial: starts on the scheme; declining the notice keeps it and sends nothing @xbrowser", async ({ page }) => {
    const eox = await watchEox(page);
    await mockApi(page, { basemap: basemapInfo(true) });
    await page.goto("/");
    await waitForMap(page);
    await cityView(page);
    expect(await page.evaluate(() => window.__smartcity!.variant)).toBe("scheme");
    await expect(page.getByTestId("basemap-switch").getByRole("button", { name: "Схема" })).toHaveAttribute("aria-pressed", "true");
    expect(eox).toEqual([]);

    // Notice first: what EOX receives.
    await hybridButton(page).click();
    const dlg = page.getByRole("dialog", { name: "Включить спутниковый гибрид?" });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText("EOX получит ваш IP-адрес");
    await expect(dlg).toContainText("какую область карты вы смотрите");
    await expect(dlg).toContainText("CC BY-NC-SA 4.0");
    await expect(dlg).toContainText("пока карта не приближена до уровня улиц");
    await expect(dlg.getByRole("button", { name: "Остаться на схеме" })).toBeFocused();
    // Real modal: Tab never leaves the dialog (the rest of the page is inert), and it passes axe.
    for (const key of ["Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), `focus after ${key}`).toBe(true);
    }
    const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
    await dlg.getByRole("button", { name: "Остаться на схеме" }).click();
    await expect(dlg).toHaveCount(0);
    // Escape declines too.
    await hybridButton(page).click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("satellite-consent")).toHaveCount(0);

    await cityView(page);
    expect(await page.evaluate(() => window.__smartcity!.variant)).toBe("scheme");
    expect(await page.evaluate(() => !!window.__smartcityMap!.getSource("satellite"))).toBe(false);
    expect(await page.evaluate(() => window.__smartcityMap!.queryRenderedFeatures({ layers: ["roads"] }).length)).toBeGreaterThan(0);
    // The page stays fully usable after declining (panel focusable again, not inert).
    await expect(page.getByRole("button", { name: "Подобрать прогулку" })).toBeVisible();
    expect(await page.evaluate(() => document.querySelectorAll("[inert]").length)).toBe(0);
    expect(eox).toEqual([]);
  });

  test("noncommercial: explicit consent enables the hybrid with the EOX credit; a new visit starts on the scheme again @xbrowser", async ({ page }) => {
    const eox = await watchEox(page);
    await mockApi(page, { basemap: basemapInfo(true) });
    await page.goto("/");
    await waitForMap(page);
    await cityView(page);
    expect(eox).toEqual([]);
    await hybridButton(page).click();
    await page.getByRole("button", { name: "Включить гибрид" }).click();
    await page.waitForFunction(() => window.__smartcity!.variant === "hybrid" && !!window.__smartcityMap!.getSource("satellite"));
    await mapIdle(page);
    expect(eox.length).toBeGreaterThan(0);
    const attrib = page.locator(".maplibregl-ctrl-attrib");
    await expect(attrib).toContainText("Contains modified Copernicus Sentinel data 2024");
    await expect(attrib).toContainText("CC BY-NC-SA 4.0");
    await expectAttributionUncovered(page);
    // Street level: satellite faded out and not rendered → no credit and no further EOX requests.
    await page.evaluate(() => window.__smartcityMap!.jumpTo({ zoom: 16.5 }));
    await mapIdle(page);
    const atStreet = eox.length;
    await page.evaluate(() => window.__smartcityMap!.panBy([300, 200], { duration: 0 }));
    await mapIdle(page);
    expect(eox.length).toBe(atStreet);
    await expect(attrib).not.toContainText("Copernicus");
    // Back to the scheme without a second notice; satellite source removed.
    await page.getByTestId("basemap-switch").getByRole("button", { name: "Схема" }).click();
    await page.waitForFunction(() => window.__smartcity!.variant === "scheme" && !window.__smartcityMap!.getSource("satellite"));
    // Coverage survives the style switch.
    expect(await page.evaluate(() => window.__smartcityMap!.queryRenderedFeatures({ layers: ["coverage-fill"] }).length)).toBeGreaterThan(0);

    // Nothing is remembered: a new visit starts on the scheme and sends nothing to EOX.
    const before = eox.length;
    await page.reload();
    await waitForMap(page);
    await cityView(page);
    expect(await page.evaluate(() => window.__smartcity!.variant)).toBe("scheme");
    expect(eox.length).toBe(before);
  });

  test("satellite unavailable: the map keeps working, the viewer is told and can return to the scheme @xbrowser", async ({ page }) => {
    const eox = await watchEox(page, "fail");
    await mockApi(page, { basemap: basemapInfo(true) });
    await page.goto("/");
    await waitForMap(page);
    await cityView(page);
    await hybridButton(page).click();
    await page.getByRole("button", { name: "Включить гибрид" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Спутниковые снимки не загрузились" })).toBeVisible();
    expect(eox.length).toBeGreaterThan(0);
    // Vector map still renders (no fallback, no fatal error).
    await expect(page.getByTestId("fallback-map")).toHaveCount(0);
    await page.evaluate(() => window.__smartcityMap!.jumpTo({ center: [71.414, 51.089], zoom: 15, pitch: 50 }));
    await mapIdle(page);
    const rendered = await page.evaluate(() => ({
      roads: window.__smartcityMap!.queryRenderedFeatures({ layers: ["roads"] }).length,
      buildings: window.__smartcityMap!.queryRenderedFeatures({ layers: ["buildings-3d", "buildings-3d-approx"] }).length,
    }));
    expect(rendered.roads).toBeGreaterThan(0);
    expect(rendered.buildings).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Только схема" }).click();
    await page.waitForFunction(() => window.__smartcity!.variant === "scheme");
  });

  test("phones: the layer toggle sits in the control column and also asks first @mobile", async ({ page, isMobile }) => {
    test.skip(!isMobile, "phone layout only");
    const eox = await watchEox(page);
    await mockApi(page, { basemap: basemapInfo(true) });
    await page.goto("/");
    await waitForMap(page);
    await expect(page.getByTestId("basemap-switch")).toBeHidden();
    const toggle = page.getByTestId("basemap-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    const t = (await toggle.boundingBox())!;
    expect(t.width).toBeGreaterThanOrEqual(44);
    const attrib = (await page.locator(".maplibregl-ctrl-attrib").boundingBox())!;
    expect(t.y + t.height).toBeLessThan(attrib.y);
    await toggle.click();
    await expect(page.getByRole("dialog", { name: "Включить спутниковый гибрид?" })).toBeVisible();
    await page.getByRole("button", { name: "Остаться на схеме" }).click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(eox).toEqual([]);
    await toggle.click();
    await page.getByRole("button", { name: "Включить гибрид" }).click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // The long EOX credit must stay visible on a phone, not hidden under controls or the sheet.
    await cityView(page);
    await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("Copernicus");
    await expectAttributionUncovered(page);
  });
});
