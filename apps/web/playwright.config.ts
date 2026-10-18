import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Deterministic browser E2E: production standalone build, every /api/* call is
 * intercepted with page.route and answered from SYNTHETIC fixtures (tests/fixtures).
 * This is NOT a live smoke test against the real API/data.
 *
 * Chromium: uses the preinstalled browser from PLAYWRIGHT_BROWSERS_PATH (chromium-1194);
 * CHROMIUM_PATH can point to another binary. Never runs `playwright install`.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const UPSTREAM_PORT = Number(process.env.E2E_UPSTREAM_PORT ?? 3109);
const pwPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
const fallbackChrome = pwPath ? path.join(pwPath, "chromium-1194/chrome-linux/chrome") : undefined;
const executablePath = process.env.CHROMIUM_PATH ?? (fallbackChrome && existsSync(fallbackChrome) && process.env.E2E_FULL_CHROME ? fallbackChrome : undefined);

const launchOptions = {
  executablePath,
  // Software WebGL in headless CI (SwiftShader via ANGLE) so MapLibre really renders.
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
};

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: "ru-RU",
    timezoneId: "Asia/Almaty",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions,
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    {
      name: "mobile-390",
      grep: /@mobile/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
    {
      name: "mobile-360",
      grep: /@mobile/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
  ],
  webServer: {
    command: process.env.E2E_SKIP_BUILD
      ? `node scripts/start-standalone.mjs ${PORT}`
      : `pnpm build && node scripts/start-standalone.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    // Browser /api calls are mocked by page.route. The upstream port is only listened on by
    // tests/e2e/xff.spec.ts (a header-recording stub); otherwise it is unreachable.
    env: { API_INTERNAL_URL: `http://127.0.0.1:${UPSTREAM_PORT}`, WEB_TRUSTED_PROXY_HOPS: "0" },
  },
});
