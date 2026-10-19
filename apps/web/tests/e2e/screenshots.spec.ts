import path from "node:path";
import { test } from "@playwright/test";
import { mapIdle, mockApi, submit, useDemoOrigin, waitForMap } from "./helpers";
import { noMatchResponse, retrievalOnlyResponse } from "../fixtures/synthetic";

/**
 * Screenshot capture (not an assertion suite). Runs only with SCREENSHOTS=1.
 * Files are named with the data they show: "synthetic" = tests/fixtures (NOT real data).
 */
const OUT = path.resolve(__dirname, "../../../../artifacts/screenshots/frontend-dev");

test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to capture screenshots");

test("capture synthetic UI states @mobile", async ({ page }, info) => {
  const tag = info.project.name;
  await mockApi(page, {
    recommend: (b, n) =>
      n === 2 ? { json: noMatchResponse(b.client_request_id) } : n === 3 ? { json: retrievalOnlyResponse(b.client_request_id) } : { json: undefined as never },
  });
  await page.goto("/");
  await waitForMap(page);
  await mapIdle(page);
  await page.screenshot({ path: `${OUT}/${tag}-01-initial-synthetic.png` });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mockApi(page);
  await useDemoOrigin(page);
  await submit(page);
  await page.getByTestId("rec-card").first().waitFor();
  await page.waitForTimeout(1200);
  await mapIdle(page);
  await page.screenshot({ path: `${OUT}/${tag}-02-results-synthetic.png` });
  await page.getByTestId("rec-marker").nth(0).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${tag}-03-selected-synthetic.png` });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mockApi(page, { recommend: (b) => ({ json: noMatchResponse(b.client_request_id) }) });
  await page.getByRole("button", { name: "Изменить запрос" }).first().click();
  await submit(page);
  await page.getByText(/Подходящих мест не нашлось/).waitFor();
  await page.screenshot({ path: `${OUT}/${tag}-04-nomatch-synthetic.png` });
});
