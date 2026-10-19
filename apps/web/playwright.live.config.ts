import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * LIVE browser smoke: the real running stack (web → API → PostgreSQL with the real OSM snapshot
 * → real embeddings + LLM). NO page.route, NO network mocks, NO fixtures.
 *
 *   SMARTCITY_LIVE_WEB_URL           web under test (default http://127.0.0.1:3000)
 *   SMARTCITY_LIVE_ARTIFACTS         output dir for screenshots / captured responses / console logs
 *                                    (default <repo>/artifacts/live/playwright)
 *   SMARTCITY_LIVE_DEGRADED_WEB_URL  optional second web whose API has unreachable AI providers
 *                                    (real provider failure, not a mock) → tests tagged @degraded
 *
 * Responses of /api/recommend take 60–200 s on CPU, so everything runs serially (1 worker) and
 * only one live recommendation is in flight at a time.
 */
const ART = path.resolve(process.env.SMARTCITY_LIVE_ARTIFACTS ?? path.join(__dirname, "../../artifacts/live/playwright"));
process.env.SMARTCITY_LIVE_ARTIFACTS = ART;

const pwPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
const has = (dirPrefix: string): boolean => {
  if (!pwPath || !existsSync(pwPath)) return false;
  return readdirSync(pwPath).some((d) => d.startsWith(dirPrefix));
};

const launchOptions = {
  // CHROMIUM_PATH can point to another Chromium build (same convention as playwright.config.ts).
  executablePath: process.env.CHROMIUM_PATH || undefined,
  // Software WebGL (SwiftShader via ANGLE) so MapLibre really renders in headless Chromium.
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
};

const extraBrowsers = [
  ...(has("firefox-") ? [{ name: "firefox-smoke", grep: /@smoke/, use: { ...devices["Desktop Firefox"], viewport: { width: 1440, height: 900 } } }] : []),
  ...(has("webkit-") ? [{ name: "webkit-smoke", grep: /@smoke/, use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } } }] : []),
];

export default defineConfig({
  testDir: "./tests/live",
  outputDir: path.join(ART, "test-results"),
  timeout: 600_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: path.join(ART, "playwright-live.json") }]],
  use: {
    baseURL: process.env.SMARTCITY_LIVE_WEB_URL ?? "http://127.0.0.1:3000",
    locale: "ru-RU",
    timezoneId: "Asia/Almaty",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions,
  },
  projects: [
    { name: "desktop-1440", grepInvert: /@mobile-only|@degraded/, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    {
      name: "mobile-390",
      grep: /@mobile/,
      grepInvert: /@degraded/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
    {
      name: "mobile-360",
      grep: /@mobile|@small/,
      grepInvert: /@degraded|@rec390/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
    ...(process.env.SMARTCITY_LIVE_DEGRADED_WEB_URL
      ? [
          {
            name: "degraded-1440",
            grep: /@degraded/,
            use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, baseURL: process.env.SMARTCITY_LIVE_DEGRADED_WEB_URL },
          },
        ]
      : []),
    ...extraBrowsers,
  ],
});
