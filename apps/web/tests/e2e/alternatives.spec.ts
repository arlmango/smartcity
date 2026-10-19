import { expect, test } from "@playwright/test";
import { mockApi, submit, useDemoOrigin } from "./helpers";

test("compare alternatives evidence @mobile", async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto("/");
  await useDemoOrigin(page);
  await page.getByRole("button", { name: "60 мин" }).click();
  await submit(page);
  await expect(page.getByTestId("rec-card")).toHaveCount(3);
  if (testInfo.project.name.startsWith("mobile")) await page.getByRole("button", { name: "Список", exact: true }).click();
  const baseline = process.env.CAPTURE_BASELINE === "1";
  if (!baseline) {
    const compare = page.getByRole("region", { name: "Сравнить варианты" });
    await expect(compare.getByRole("button")).toHaveCount(3);
    await compare.getByRole("button").nth(1).click();
    await expect(page.getByTestId("rec-card").nth(1)).toHaveAttribute("aria-current", "true");
  }
  if (!baseline) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (testInfo.project.name.startsWith("mobile")) {
      // Map markers must not escape their stacking context above the full-height sheet.
      expect(await page.getByTestId("rec-marker").first().evaluate((marker) => {
        const box = marker.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return !!hit?.closest("aside");
      })).toBe(true);
    }
  }
  const metric = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="rec-card"]')];
    const compare = document.querySelector('[aria-label="Сравнить варианты"]');
    return { detailedCardSpanPx: Math.round(cards[2]!.getBoundingClientRect().top - cards[0]!.getBoundingClientRect().top), comparisonHeightPx: compare ? Math.round(compare.getBoundingClientRect().height) : null };
  });
  console.log(JSON.stringify({ viewport: testInfo.project.name, baseline, ...metric }));
  await page.screenshot({ path: `../../artifacts/iteration/${baseline ? "before" : "after"}-${testInfo.project.name}.png` });
  if (!baseline) {
    await page.getByRole("button", { name: "Начать заново", exact: true }).click();
    await expect(page.getByRole("region", { name: "Сравнить варианты" })).toHaveCount(0);
    await useDemoOrigin(page);
  await page.getByRole("button", { name: "60 мин" }).click();
    await submit(page);
    await expect(page.getByRole("region", { name: "Сравнить варианты" }).getByRole("button")).toHaveCount(3);
    await expect(page.locator('[data-testid="rec-card"][aria-current="true"]')).toHaveCount(0);
  }
});

test("selection survives delayed explanation @mobile", async ({ page }, testInfo) => {
  const { okResponse, retrievalOnlyResponse } = await import("../fixtures/synthetic");
  await mockApi(page);
  await page.addInitScript(({ preliminary, final }) => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      if (String(args[0]).includes("/api/recommend/stream")) {
        const request = JSON.parse(String(args[1]?.body));
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({
          start(controller) {
            const emit = (event: string, response: typeof final) => controller.enqueue(encoder.encode(JSON.stringify({ event, response: { ...response, client_request_id: request.client_request_id } }) + "\n"));
            emit("preliminary", preliminary);
            setTimeout(() => { emit("final", final); controller.close(); }, 2500);
          },
        }), { headers: { "Content-Type": "application/x-ndjson" } });
      }
      return original(...args);
    };
  }, { preliminary: retrievalOnlyResponse("test-stream-123"), final: okResponse("test-stream-123") });
  await page.goto("/");
  await useDemoOrigin(page);
  await page.getByRole("button", { name: "60 мин" }).click();
  const started = Date.now();
  await submit(page);
  const card = page.getByTestId("rec-card").first();
  await expect(card).toBeVisible();
  const firstCardMs = Date.now() - started;
  await card.getByRole("button", { name: "Показать на карте" }).click();
  await expect(card).toHaveAttribute("aria-current", "true");
  await expect(page.getByText("Места уже найдены поиском по базе — ИИ ещё готовит объяснения.")).toHaveCount(0);
  const baseline = process.env.CAPTURE_BASELINE === "1";
  if (baseline) await expect(card).not.toHaveAttribute("aria-current", "true");
  else {
    await expect(card).toHaveAttribute("aria-current", "true");
    await expect(card.getByRole("button", { name: "Показано на карте" })).toBeFocused();
  }
  console.log(JSON.stringify({ viewport: testInfo.project.name, baseline, firstCardMs, finalMs: Date.now() - started, selectionRetained: !baseline, timing: "synthetic 2500ms generation delay; not live model latency" }));
});
