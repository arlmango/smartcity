import { expect, test } from "@playwright/test";
import { okResponse, readyOk } from "../fixtures/synthetic";
import { mockApi, submit, useDemoOrigin } from "./helpers";

test.describe("deterministic: start time & provider disclosure (SYNTHETIC fixtures)", () => {
  test("start time: default omitted; chosen time sent as +05:00 and shown in summary", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto("/");
    await useDemoOrigin(page);
    await submit(page);
    await expect(page.getByTestId("hours-checked-at")).toHaveText("Часы работы проверены на время прибытия при старте сейчас.");
    expect(api.recommendBodies[0]!.start_time).toBeNull();

    await page.getByRole("button", { name: "Изменить запрос" }).first().click();
    await page.getByRole("button", { name: "Указать время" }).click();
    const input = page.getByLabel("Дата и время старта (по времени Астаны)");
    const local = await page.evaluate(() => {
      const d = new Date(Date.now() + 5 * 3600_000 + 26 * 3600_000); // tomorrow, Astana wall clock
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T19:30`;
    });
    await input.fill(local);
    await submit(page);
    await expect(page.getByTestId("rec-card")).toHaveCount(3);
    expect(api.recommendBodies[1]!.start_time).toBe(`${local}:00+05:00`);
    await expect(page.getByTestId("hours-checked-at")).toContainText(", 19:30 (время Астаны)");

    await page.getByRole("button", { name: "Изменить запрос" }).first().click();
    await input.fill("2020-01-01T10:00");
    await expect(page.getByText("Время уже прошло", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Подобрать прогулку" })).toBeDisabled();
    await page.getByRole("button", { name: "Сейчас", exact: true }).click();
    await expect(page.getByRole("button", { name: "Подобрать прогулку" })).toBeEnabled();
  });

  test("О данных: local Ollama vs external provider disclosure", async ({ page }) => {
    await mockApi(page, {
      ready: {
        ready: true,
        components: {
          ...readyOk.components,
          llm: { status: "ok", detail: "ollama:qwen2.5:3b" },
          embeddings: { status: "ok", detail: "ollama:bge-m3, dim 1024; в индексе 3" },
        },
      },
      recommend: (b) => {
        const base = okResponse(b.client_request_id);
        return { json: { ...base, providers: { ...base.providers, llm_provider: "openai_compatible", llm_model: "ext-model" } } };
      },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "О данных" }).click();
    const disc = page.getByTestId("provider-disclosure");
    await expect(disc).toContainText("локальная модель (Ollama) (qwen2.5:3b) — текст не покидает сервер");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("external-provider-note")).toHaveCount(0);

    await useDemoOrigin(page);
    await submit(page);
    await expect(page.getByTestId("rec-card")).toHaveCount(3);
    await page.getByRole("button", { name: "О данных" }).click();
    await expect(disc).toContainText("текст запроса отправляется внешнему провайдеру");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Изменить запрос" }).first().click();
    await expect(page.getByTestId("external-provider-note")).toBeVisible();
  });
});
