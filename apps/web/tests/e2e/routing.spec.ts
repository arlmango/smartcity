import { expect, test } from "@playwright/test";
import { mockApi, submit, useDemoOrigin } from "./helpers";
import { okResponse, recA, recB } from "../fixtures/synthetic";
import { walkingRoute } from "../fixtures/walkingRoute";

// These fixtures exercise rendering/state only; real geometry is checked by the live pilot.
test("network route selection, return, reset and no graph @mobile", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockApi(page, { recommend: (body, n) => ({ json: okResponse(body.client_request_id, n > 1 ? [recA] : [
    { ...recA, route: walkingRoute, distance: { ...recA.distance, method: "pedestrian_route" } },
    { ...recB, route: { ...walkingRoute, return_leg: null }, distance: { ...recB.distance, method: "pedestrian_route" } },
  ]) }) });
  await page.goto("/");
  await useDemoOrigin(page);
  await submit(page);
  await expect(page.getByTestId("route-legend")).toContainText("обратно");
  await expect(page.getByTestId("route-legend")).toContainText("Подход к месту не проверен");
  await expect(page.getByTestId("route-endpoint")).toHaveCount(2);
  await expect(page.getByTestId("height-legend")).not.toHaveAttribute("open");
  await expect(page.getByTestId("route-details").first()).not.toBeVisible();
  await expect(page.getByTestId("route-legend")).not.toContainText(/OSM|Valhalla/);
  await expect(page.getByTestId("rec-card").first()).toHaveAttribute("aria-current", "true");
  await expect.poll(() => page.evaluate(async () => {
    const source = window.__smartcityMap?.getSource("walking-route") as import("maplibre-gl").GeoJSONSource | undefined;
    const data = await source?.getData();
    return data?.type === "FeatureCollection" ? data.features.length : undefined;
  })).toBe(2);
  if (testInfo.project.name.startsWith("mobile")) await page.getByRole("button", { name: "Список", exact: true }).click();
  await page.getByRole("region", { name: "Сравнить варианты" }).getByRole("button").nth(1).click();
  await expect(page.getByTestId("route-legend")).not.toContainText("обратно");
  // Reselecting the same card restores its complete network path after a manual pan.
  await page.evaluate(() => window.__smartcityMap?.jumpTo({ center: [71.44, 51.11], zoom: 17 }));
  await page.getByRole("region", { name: "Сравнить варианты" }).getByRole("button").nth(1).click();
  await expect.poll(() => page.evaluate((coordinates) => {
    const bounds = window.__smartcityMap?.getBounds();
    return coordinates.every((p) => bounds?.contains(p));
  }, walkingRoute.outbound.geometry.coordinates)).toBe(true);
  await expect.poll(() => page.evaluate(async () => {
    const source = window.__smartcityMap?.getSource("walking-route") as import("maplibre-gl").GeoJSONSource | undefined;
    const data = await source?.getData();
    return data?.type === "FeatureCollection" ? data.features.length : undefined;
  })).toBe(1);
  await page.getByRole("button", { name: "Начать заново", exact: true }).click();
  await expect(page.getByTestId("route-legend")).toHaveCount(0);
  await expect(page.getByTestId("route-endpoint")).toHaveCount(0);
  await useDemoOrigin(page);
  await submit(page);
  await expect(page.getByTestId("route-unavailable")).toBeVisible();
  await expect(page.getByTestId("route-endpoint")).toHaveCount(0);
});

test("changing start hides saved route and repeated request clears geometry @mobile", async ({ page }, testInfo) => {
  await mockApi(page, { recommend: (body, n) => ({
    delayMs: n > 1 ? 1200 : 0,
    json: okResponse(body.client_request_id, [{ ...recA, route: walkingRoute }]),
  }) });
  await page.goto("/");
  await useDemoOrigin(page);
  await submit(page);
  await expect(page.getByTestId("route-endpoint")).toHaveCount(2);
  if (testInfo.project.name.startsWith("mobile")) await page.getByRole("button", { name: "Список", exact: true }).click();
  await page.getByRole("button", { name: "Изменить запрос", exact: true }).click();
  await page.getByLabel("Найти место в нашей базе").fill("музей");
  await page.getByRole("button", { name: /SYNTHETIC Музей тестов/ }).click();
  await expect(page.getByTestId("route-endpoint")).toHaveCount(0);
  await page.getByRole("button", { name: "Вернуться к результатам" }).click();
  await expect(page.getByTestId("rec-card")).toHaveCount(1);
  await expect(page.getByTestId("route-legend")).toHaveCount(0);
  await page.getByRole("button", { name: "Изменить запрос", exact: true }).click();
  await useDemoOrigin(page);
  await expect(page.getByTestId("route-endpoint")).toHaveCount(2);
  await submit(page);
  await expect(page.getByTestId("route-endpoint")).toHaveCount(0);
  await expect(page.getByTestId("route-legend")).toHaveCount(0);
  await expect(page.getByTestId("route-endpoint")).toHaveCount(2);
});
