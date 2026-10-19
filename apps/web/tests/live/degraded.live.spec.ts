/**
 * LIVE provider failure: a second, real API instance whose AI_BASE_URL / EMBEDDING_BASE_URL point
 * to a closed port (real connection refused, not a mock), same real DB. Runs only when
 * SMARTCITY_LIVE_DEGRADED_WEB_URL is set (project "degraded-1440").
 */
import { expect, test } from "@playwright/test";
import { checkInvariants, collect, lastResponse, shot, submit, useDemoOrigin, waitForMap, waitForOutcome } from "./helpers";

test.describe("live: provider failure", () => {
  test("LLM + embeddings down → banners, retrieval_only answer from the real DB @degraded", async ({ page }, info) => {
    const c = collect(page, info);
    await page.goto("/");
    await waitForMap(page);
    await expect(page.getByTestId("provider-banner").first()).toContainText(/ИИ сейчас недоступен|Поиск по смыслу недоступен/);
    await useDemoOrigin(page);
    await page.getByLabel("Что хочется").fill("Я возле Mega Silk Way, есть 40 минут, хочу немного прогуляться");
    await submit(page);
    await waitForOutcome(page, 120_000);
    const r = await lastResponse(c);
    expect(r.mode).toBe("retrieval_only");
    expect(r.status).toBe("degraded");
    const codes = (r.warnings as { code: string }[]).map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(["llm_unavailable", "embeddings_unavailable"]));
    await expect(page.getByTestId("retrieval-only")).toHaveText("ИИ временно недоступен — показаны найденные места без объяснений ИИ.");
    for (const rec of r.recommendations) expect((rec as unknown as { reason: string | null }).reason).toBeNull();
    checkInvariants(r, 40, true);
    await shot(page, info, "70-provider-failure-retrieval-only");
    c.flush();
  });
});
