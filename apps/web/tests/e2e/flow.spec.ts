import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  XSS_NAME,
  clarificationResponse,
  noMatchResponse,
  okResponse,
  readyLlmDown,
  recA,
  retrievalOnlyResponse,
} from "../fixtures/synthetic";
import { mockApi, submit, useDemoOrigin, waitForMap } from "./helpers";

async function cardIds(page: Page) {
  return page.getByTestId("rec-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-place-id")));
}
async function markerIds(page: Page) {
  return page.getByTestId("rec-marker").evaluateAll((els) => els.map((e) => e.getAttribute("data-place-id")));
}

test.describe("deterministic: recommendation flow (SYNTHETIC fixtures)", () => {
  test("submit → 1–3 cards and markers share place_id; card ↔ marker selection @mobile", async ({ page, isMobile }) => {
    const api = await mockApi(page);
    await page.goto("/");
    await waitForMap(page);
    await useDemoOrigin(page);
    await page.getByLabel("Что хочется").fill("Хочу кофе и немного прогуляться");
    await page.getByRole("button", { name: "Кофе", exact: true }).click();
    await page.getByRole("button", { name: "60 мин" }).click();
    await submit(page);

    await expect(page.getByTestId("rec-card")).toHaveCount(3);
    await expect(page.getByTestId("rec-marker")).toHaveCount(3);
    expect(await cardIds(page)).toEqual(await markerIds(page));
    expect(await cardIds(page)).toEqual(["synthetic-cafe-1", "synthetic-playground-2", "synthetic-museum-3"]);
    // marker numbers equal card numbers
    expect(await page.getByTestId("rec-marker").allTextContents()).toEqual(["1", "2", "3"]);

    const body = api.recommendBodies[0]!;
    expect(body.travel_mode).toBe("walking");
    expect(body.time_budget_min).toBe(60);
    expect(body.interests).toEqual(["coffee"]);
    expect(body.origin).toEqual({ lat: 51.0889, lon: 71.4152 });
    expect(body.client_request_id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);

    // Generic playground name is labelled honestly.
    await expect(page.getByText("Детская площадка · без названия в OSM")).toBeVisible();

    // card → marker
    const card2 = page.locator('[data-testid="rec-card"][data-place-id="synthetic-playground-2"]');
    await card2.getByRole("button", { name: "Показать на карте" }).click();
    await expect(page.locator('[data-testid="rec-marker"][data-place-id="synthetic-playground-2"]')).toHaveAttribute("aria-pressed", "true");
    await expect(card2).toHaveAttribute("aria-current", "true");

    // marker → card
    if (isMobile) await page.getByRole("button", { name: "Карта", exact: true }).click();
    await page.getByTestId("fit-results").click();
    await page.waitForFunction(() => !window.__smartcityMap!.isMoving());
    await page.locator('[data-testid="rec-marker"][data-place-id="synthetic-museum-3"]').click();
    const card3 = page.locator('[data-testid="rec-card"][data-place-id="synthetic-museum-3"]');
    await expect(card3).toHaveAttribute("aria-current", "true");
    await expect(card3).toBeInViewport();
    // The page shell itself never scrolls (only the panel does): header stays visible.
    expect(await page.evaluate(() => (document.body.firstElementChild as HTMLElement).scrollTop)).toBe(0);
    await expect(page.getByRole("button", { name: "О данных" })).toBeInViewport();
    await expect(page.locator('[data-testid="rec-marker"][data-place-id="synthetic-playground-2"]')).toHaveAttribute("aria-pressed", "false");
    expect(api.unmocked).toEqual([]);
  });

  test("no_match explains and relaxation resends the server patch", async ({ page }) => {
    const api = await mockApi(page, {
      recommend: (b, n) => ({ json: n === 1 ? noMatchResponse(b.client_request_id) : okResponse(b.client_request_id, [recA]) }),
    });
    await page.goto("/");
    await useDemoOrigin(page);
    await page.getByText("Обязательные условия").click();
    await page.getByLabel("Розетки").check();
    await submit(page);
    await expect(page.getByRole("heading", { name: /Подходящих мест не нашлось/ })).toBeVisible();
    await expect(page.getByText(/нет мест, где розетки подтверждены/)).toBeVisible();
    expect(api.recommendBodies[0]!.constraints.required_features).toEqual(["socket"]);
    await page.getByRole("button", { name: "Показать кафе, где наличие розеток не подтверждено" }).click();
    await expect(page.getByTestId("rec-card")).toHaveCount(1);
    const second = api.recommendBodies[1]!;
    expect(second.constraints.required_features).toEqual([]);
    expect(second.constraints.preferred_features).toEqual(["socket"]);
    expect(second.conversation_context.length).toBeGreaterThan(0);
    await expect(page.getByText("Наличие розеток не подтверждено")).toBeVisible();
  });

  test("quick refinements keep earlier hard conditions", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto("/");
    await useDemoOrigin(page);
    await page.getByText("Обязательные условия").click();
    await page.getByLabel("Wi‑Fi").check();
    await submit(page);
    await expect(page.getByTestId("rec-card")).toHaveCount(3);
    await page.getByRole("button", { name: "Без кафе" }).click();
    await expect(page.getByTestId("rec-card")).toHaveCount(3);
    await page.getByRole("button", { name: "Поближе" }).click();
    await expect(page.getByTestId("rec-card")).toHaveCount(3);
    await page.getByRole("button", { name: "Только внутри" }).click();
    await expect(page.getByTestId("rec-card")).toHaveCount(3);
    await page.getByRole("button", { name: "Другие варианты" }).click();
    await expect(page.getByTestId("rec-card")).toHaveCount(3);
    const [, b2, b3, b4, b5] = api.recommendBodies;
    expect(b2!.constraints.exclude_categories).toEqual(["cafe"]);
    expect(b2!.constraints.required_features).toEqual(["wifi"]);
    expect(b3!.constraints.max_distance_m).toBeLessThan(610);
    expect(b3!.constraints.exclude_categories).toEqual(["cafe"]);
    expect(b4!.constraints.required_features.sort()).toEqual(["indoor", "wifi"]);
    expect(b4!.constraints.max_distance_m).toBe(b3!.constraints.max_distance_m);
    expect(b5!.constraints.exclude_place_ids).toEqual(["synthetic-cafe-1", "synthetic-playground-2", "synthetic-museum-3"]);
    expect(b5!.conversation_context.length).toBeLessThanOrEqual(6);
    const ids = new Set(api.recommendBodies.map((b) => b.client_request_id));
    expect(ids.size).toBe(5);

    // "Начать заново" clears everything local.
    await page.getByRole("button", { name: "Начать заново" }).click();
    await expect(page.getByRole("heading", { name: "Куда пойдём?" })).toBeVisible();
    await expect(page.getByTestId("rec-marker")).toHaveCount(0);
    await expect(page.getByText("Точка не выбрана", { exact: false })).toBeVisible();
  });

  test("retrieval_only shows the 'ИИ временно недоступен' banner; provider status banner from /api/ready", async ({ page }) => {
    await mockApi(page, { ready: readyLlmDown, recommend: (b) => ({ json: retrievalOnlyResponse(b.client_request_id) }) });
    await page.goto("/");
    await expect(page.getByTestId("provider-banner")).toContainText("ИИ сейчас недоступен");
    await useDemoOrigin(page);
    await submit(page);
    await expect(page.getByTestId("retrieval-only")).toHaveText("ИИ временно недоступен — показаны найденные места без объяснений ИИ.");
    await expect(page.getByText("Объяснение ИИ недоступно", { exact: false })).toBeVisible();
  });

  test("model timeout after the places were found: the found places stay, with a note @mobile", async ({ page }) => {
    await mockApi(page, {
      recommend: (b) => ({
        json: null,
        preliminary: { ...retrievalOnlyResponse(b.client_request_id), status: "ok" },
        streamError: { error: "timeout", message: "Превышено время обработки запроса." },
      }),
    });
    await page.goto("/");
    await useDemoOrigin(page);
    await submit(page);
    await expect(page.getByTestId("partial-note")).toContainText("Объяснения ИИ не получены");
    await expect(page.getByTestId("rec-card")).toHaveCount(1);
    await expect(page.getByTestId("rec-marker")).toHaveCount(1);
  });

  test("preliminary places are replaced by the final AI answer", async ({ page }) => {
    await mockApi(page, {
      recommend: (b) => ({ json: okResponse(b.client_request_id), preliminary: retrievalOnlyResponse(b.client_request_id) }),
    });
    await page.goto("/");
    await useDemoOrigin(page);
    await submit(page);
    await expect(page.getByTestId("rec-card")).toHaveCount(3);
    await expect(page.getByTestId("partial-note")).toHaveCount(0);
    await expect(page.getByTestId("retrieval-only")).toHaveCount(0);
  });

  test("provider error → error state; retry reuses the same client_request_id", async ({ page }) => {
    const api = await mockApi(page, {
      recommend: (b, n) =>
        n === 1
          ? { status: 503, json: { error: "provider_unavailable", message: "Сервис подбора временно недоступен.", request_id: "r1" } }
          : { json: okResponse(b.client_request_id) },
    });
    await page.goto("/");
    await useDemoOrigin(page);
    await submit(page);
    await expect(page.getByTestId("error-card")).toContainText("Сервис подбора временно недоступен.");
    await page.getByRole("button", { name: "Повторить" }).click();
    await expect(page.getByTestId("rec-card")).toHaveCount(3);
    expect(api.recommendBodies).toHaveLength(2);
    expect(api.recommendBodies[1]!.client_request_id).toBe(api.recommendBodies[0]!.client_request_id);
  });

  test("invalid API response becomes an error state, not a crash", async ({ page }) => {
    await mockApi(page, { recommend: (b) => ({ json: { ...okResponse(b.client_request_id), recommendations: "nope" } }) });
    await page.goto("/");
    await useDemoOrigin(page);
    await submit(page);
    await expect(page.getByTestId("error-card")).toContainText("неожиданном формате");
  });

  test("long request shows progress and can be cancelled; late answer is ignored", async ({ page }) => {
    await mockApi(page, { recommend: (b) => ({ json: okResponse(b.client_request_id), delayMs: 4000 }) });
    await page.goto("/");
    await useDemoOrigin(page);
    await submit(page);
    await expect(page.getByTestId("progress")).toBeVisible();
    await expect(page.locator("ol").getByText("Отправляем запрос")).toBeVisible();
    await page.getByRole("button", { name: "Отменить" }).click();
    await expect(page.getByText("Запрос отменён.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Куда пойдём?" })).toBeVisible();
    await page.waitForTimeout(4500);
    await expect(page.getByTestId("rec-card")).toHaveCount(0);
    await expect(page.getByTestId("rec-marker")).toHaveCount(0);
  });

  test("needs_clarification asks a question and lets the user change conditions", async ({ page }) => {
    await mockApi(page, { recommend: (b) => ({ json: clarificationResponse(b.client_request_id) }) });
    await page.goto("/");
    await useDemoOrigin(page);
    await submit(page);
    await expect(page.getByText(/противоречат друг другу/)).toBeVisible();
    await page.getByRole("button", { name: "Изменить условия" }).click();
    await expect(page.getByRole("heading", { name: "Куда пойдём?" })).toBeVisible();
  });

  test("T25: HTML in a place name is rendered as text (cards and markers)", async ({ page }) => {
    await mockApi(page, { recommend: (b) => ({ json: okResponse(b.client_request_id, [{ ...recA, name: XSS_NAME }]) }) });
    await page.goto("/");
    await useDemoOrigin(page);
    await submit(page);
    await expect(page.getByTestId("rec-card")).toHaveCount(1);
    await expect(page.locator("#card-title-1")).toContainText('<img src=x onerror="window.__xss=1">');
    expect(await page.locator('[data-testid="rec-card"] img').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    await expect(page.getByTestId("rec-marker")).toHaveAttribute("aria-label", /<img src=x/);
  });

  test("place search sets the origin from our own base", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.getByLabel("Найти место в нашей базе").fill("музей");
    await page.getByRole("button", { name: /SYNTHETIC Музей тестов/ }).click();
    await expect(page.getByTestId("origin-label")).toHaveText("SYNTHETIC Музей тестов");
  });
});

test.describe("deterministic: geolocation", () => {
  test("denied geolocation keeps the form usable @mobile", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Моё местоположение" }).click();
    await expect(page.getByText(/Браузер спросит разрешение/)).toBeVisible();
    await page.getByRole("button", { name: "Разрешить запрос" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /не разрешён|Не удалось определить/ })).toBeVisible();
    await useDemoOrigin(page);
    await expect(page.getByRole("button", { name: "Подобрать прогулку" })).toBeEnabled();
  });

  test("granted geolocation outside coverage is explained, not used", async ({ page, context }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 43.238, longitude: 76.945 }); // Almaty, outside coverage
    await mockApi(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Моё местоположение" }).click();
    await page.getByRole("button", { name: "Разрешить запрос" }).click();
    await expect(page.getByText(/Ваше местоположение вне зоны покрытия/)).toBeVisible();
    await expect(page.getByText("Точка не выбрана", { exact: false })).toBeVisible();
  });
});

test.describe("deterministic: fallback & states", () => {
  test("WebGL unavailable → SVG 2D fallback with picking, markers and list @mobile", async ({ page, isMobile }) => {
    await page.addInitScript(() => {
      const proto = HTMLCanvasElement.prototype as unknown as { getContext: (this: HTMLCanvasElement, t: string, ...r: unknown[]) => unknown };
      const orig = proto.getContext;
      proto.getContext = function (type: string, ...rest: unknown[]) {
        if (/webgl/i.test(type)) return null; // simulate a browser without WebGL
        return orig.call(this, type, ...rest);
      };
    });
    await mockApi(page);
    await page.goto("/");
    await expect(page.getByTestId("fallback-map")).toBeVisible();
    await expect(page.getByText("Упрощённая карта.")).toBeVisible();
    await expect(page.locator('[data-testid="fallback-map"] path').first()).toBeAttached();
    expect(await page.locator('[data-testid="fallback-map"] path').count()).toBeGreaterThan(30);
    const svg = page.getByRole("img", { name: /Упрощённая 2D/ });
    const box = (await svg.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByTestId("origin-label")).toHaveText("Точка на карте");
    if (isMobile) await page.getByRole("button", { name: "Список" }).click();
    await submit(page);
    await expect(page.getByTestId("rec-card")).toHaveCount(3);
    await expect(page.getByTestId("rec-marker")).toHaveCount(3);
    expect(await cardIds(page)).toEqual(await markerIds(page));
  });

  test("offline state is shown and blocks submit", async ({ page, context }) => {
    await mockApi(page);
    await page.goto("/");
    await useDemoOrigin(page);
    await context.setOffline(true);
    await expect(page.getByTestId("offline-banner")).toBeVisible();
    await expect(page.getByRole("button", { name: "Подобрать прогулку" })).toBeDisabled();
    await context.setOffline(false);
    await expect(page.getByTestId("offline-banner")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Подобрать прогулку" })).toBeEnabled();
  });

  test("API down → explicit banner", async ({ page }) => {
    await mockApi(page, { ready: { status: 502 } });
    await page.goto("/");
    await expect(page.getByTestId("api-banner")).toContainText("API недоступен");
  });

  test("О данных: coverage, snapshot date, place count, OSM/ODbL, approximate heights", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await waitForMap(page);
    await page.getByRole("button", { name: "О данных" }).click();
    const dlg = page.getByRole("dialog", { name: "О данных" });
    await expect(dlg).toContainText("SYNTHETIC тестовое покрытие");
    await expect(dlg).toContainText("1 октября 2026");
    await expect(dlg).toContainText("ODbL");
    await expect(dlg).toContainText("Высоты зданий приблизительные");
    await expect(dlg).toContainText("10 — условно 10 м");
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
  });
});

test.describe("deterministic: accessibility", () => {
  test("axe: no serious/critical violations (initial and results) @mobile", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await waitForMap(page);
    const check = async () => {
      const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const bad = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    };
    await check();
    await useDemoOrigin(page);
    await submit(page);
    await expect(page.getByTestId("rec-card")).toHaveCount(3);
    await check();
  });

  test("keyboard only: choose demo origin, submit, open a card on the map", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await waitForMap(page);
    const focusByTab = async (name: RegExp, max = 60) => {
      for (let i = 0; i < max; i++) {
        await page.keyboard.press("Tab");
        const label = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return (el?.getAttribute("aria-label") ?? el?.textContent ?? "").trim();
        });
        if (name.test(label)) return;
      }
      throw new Error(`focus never reached ${name}`);
    };
    await focusByTab(/Демо-точка/);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("origin-label")).toContainText("Демо-точка");
    await focusByTab(/Подобрать прогулку/);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("rec-card")).toHaveCount(3);
    await focusByTab(/Показать на карте/);
    const focusedVisible = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle !== "none");
    expect(focusedVisible).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-testid="rec-marker"][aria-pressed="true"]')).toHaveCount(1);
    // Map controls are reachable and operable by keyboard.
    await page.getByRole("button", { name: "3D-здания" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("toggle-3d")).toHaveAttribute("aria-pressed", "false");
  });
});
