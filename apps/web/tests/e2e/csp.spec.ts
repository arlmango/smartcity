import { expect, test } from "@playwright/test";
import { mapIdle, mockApi, submit, useDemoOrigin, waitForMap } from "./helpers";

test("security headers + CSP: map and results work without CSP violations @mobile", async ({ page }) => {
  const consoleCsp: string[] = [];
  page.on("console", (m) => /Content Security Policy|Refused to/i.test(m.text()) && consoleCsp.push(m.text()));
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  await mockApi(page);
  const resp = await page.goto("/");
  const h = resp!.headers();
  const csp = h["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("worker-src 'self' blob:");
  expect(csp).not.toContain("unsafe-eval");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");

  await waitForMap(page);
  await mapIdle(page);
  const rendered = await page.evaluate(() => window.__smartcityMap!.queryRenderedFeatures({ layers: ["buildings-3d", "buildings-3d-approx"] }).length);
  expect(rendered).toBeGreaterThan(0); // MapLibre workers (blob:) are allowed
  await useDemoOrigin(page);
  await submit(page);
  await expect(page.getByTestId("rec-card")).toHaveCount(3);
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  expect(consoleCsp).toEqual([]);
});
