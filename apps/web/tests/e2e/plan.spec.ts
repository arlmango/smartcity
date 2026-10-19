import { expect, test } from "@playwright/test";
import { mockApi, submit, useDemoOrigin } from "./helpers";
import { okResponse, recA, recB, recC } from "../fixtures/synthetic";
import { walkingRoute, walkPlan } from "../fixtures/walkingRoute";

// SYNTHETIC fixtures: rendering and state only. Real plan geometry is checked against a live router.
const routed = [
  { ...recA, route: walkingRoute, distance: { ...recA.distance, method: "pedestrian_route" as const } },
  recB,
  recC,
];

test("timebox plan: shown first, card switches, plan returns, remove stop keeps conditions @mobile", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const mock = await mockApi(page, {
    recommend: (body, n) => ({
      json: n === 1
        ? { ...okResponse(body.client_request_id, routed), plan: walkPlan }
        : { ...okResponse(body.client_request_id, [recB, recC]), plan: null,
            plan_note: "В 60 мин не помещаются две остановки с возвратом к старту. Выберите одно место из вариантов ниже или увеличьте время." },
    }),
  });
  await page.goto("/");
  await useDemoOrigin(page);
  await page.getByRole("button", { name: "60 мин" }).click();
  await submit(page);
  const plan = page.getByTestId("walk-plan");
  await expect(plan).toBeVisible();
  await expect(plan).toContainText("2 остановки");
  await expect(page.getByRole("button", { name: "План показан на карте" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("plan-stop-mark")).toHaveCount(2);
  // Result numbers would clash with stop numbers: only the plan's stops are marked while it is shown.
  await expect(page.getByTestId("rec-marker")).toHaveCount(0);
  await expect(page.getByTestId("route-legend")).toContainText("План прогулки");
  await expect(page.getByTestId("route-legend")).toContainText("обратно");
  await expect(page.locator('[data-testid="rec-card"][aria-current="true"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => {
    const source = window.__smartcityMap?.getSource("walking-route") as import("maplibre-gl").GeoJSONSource | undefined;
    const data = await source?.getData();
    return data?.type === "FeatureCollection" ? data.features.length : undefined;
  })).toBe(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (testInfo.project.name.startsWith("mobile")) await page.getByRole("button", { name: "Список", exact: true }).click();
  // Choosing one place replaces the plan on the map (no mixed geometry).
  await page.getByTestId("rec-card").first().getByRole("button", { name: "Показать на карте" }).click();
  await expect(page.getByTestId("plan-stop-mark")).toHaveCount(0);
  await expect(page.getByTestId("route-endpoint")).toHaveCount(2);
  await expect(page.getByTestId("rec-marker")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Показать план на карте" })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Показать план на карте" }).click();
  await expect(page.getByTestId("route-endpoint")).toHaveCount(0);
  await expect(page.getByTestId("plan-stop-mark")).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath(`plan-${testInfo.project.name}.png`) });
  // Remove a stop: same request with that place excluded; old plan geometry disappears at once.
  await page.getByRole("button", { name: "Убрать остановку: SYNTHETIC Кафе «Тест»" }).click();
  await expect(page.getByTestId("plan-note")).toContainText("не помещаются две остановки");
  await expect(page.getByTestId("walk-plan")).toHaveCount(0);
  await expect(page.getByTestId("plan-stop-mark")).toHaveCount(0);
  const [first, second] = mock.recommendBodies;
  expect(second!.constraints.exclude_place_ids).toEqual(["synthetic-cafe-1"]);
  expect(second!.time_budget_min).toBe(first!.time_budget_min);
  expect(second!.return_to_start).toBe(first!.return_to_start);
  expect(second!.client_request_id).not.toBe(first!.client_request_id);
});

test("changing the start after a plan hides its line and marks it stale @mobile", async ({ page }, testInfo) => {
  await mockApi(page, { recommend: (body) => ({ json: { ...okResponse(body.client_request_id, routed), plan: walkPlan } }) });
  await page.goto("/");
  await useDemoOrigin(page);
  await submit(page);
  await expect(page.getByTestId("plan-stop-mark")).toHaveCount(2);
  if (testInfo.project.name.startsWith("mobile")) await page.getByRole("button", { name: "Список", exact: true }).click();
  await page.getByRole("button", { name: "Изменить запрос", exact: true }).click();
  await page.getByLabel("Найти место в нашей базе").fill("музей");
  await page.getByRole("button", { name: /SYNTHETIC Музей тестов/ }).click();
  await page.getByRole("button", { name: "Вернуться к результатам" }).click();
  await expect(page.getByTestId("plan-stale")).toBeVisible();
  await expect(page.getByTestId("plan-stop-mark")).toHaveCount(0);
  // No plan line is drawn, so the result markers are back rather than an empty map.
  await expect(page.getByTestId("rec-marker")).toHaveCount(3);
});
