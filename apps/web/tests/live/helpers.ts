/**
 * LIVE helpers. No page.route / mocks: every request goes to the real web → API → DB → models.
 * Collectors write evidence (console errors, failed requests, captured /api/recommend
 * request+response pairs, screenshots) into SMARTCITY_LIVE_ARTIFACTS.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";

export const ART = process.env.SMARTCITY_LIVE_ARTIFACTS ?? path.resolve(__dirname, "../../../../artifacts/live/playwright");
export const SHOTS = path.join(ART, "screenshots");
const RESP = path.join(ART, "responses");
const CONSOLE = path.join(ART, "console");
for (const d of [SHOTS, RESP, CONSOLE]) mkdirSync(d, { recursive: true });

/** A real recommendation on CPU (qwen2.5:3b) takes 60–200 s. */
export const LIVE_REC_TIMEOUT = 300_000;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

export interface Captured {
  request: Record<string, unknown>;
  status: number;
  response: Record<string, unknown> | null;
  ms: number;
}

export interface Collectors {
  recs: Captured[];
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  httpErrors: string[];
  flush: () => void;
}

/** Attach evidence collectors to the page; call `flush()` at the end of the test. */
export function collect(page: Page, info: TestInfo): Collectors {
  const c: Collectors = { recs: [], consoleErrors: [], pageErrors: [], failedRequests: [], httpErrors: [], flush: () => {} };
  const started = new Map<string, number>();
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") c.consoleErrors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => c.pageErrors.push(e.message));
  page.on("request", (r) => {
    if (r.url().includes("/api/recommend")) started.set(r.url() + (r.postData() ?? ""), Date.now());
  });
  page.on("requestfailed", (r) => c.failedRequests.push(`${r.method()} ${new URL(r.url()).pathname} — ${r.failure()?.errorText ?? "?"}`));
  page.on("response", async (res) => {
    const url = new URL(res.url());
    if (res.status() >= 400) c.httpErrors.push(`${res.request().method()} ${url.pathname} → ${res.status()}`);
    if (url.pathname === "/api/recommend" && res.request().method() === "POST") {
      const req = res.request();
      const key = req.url() + (req.postData() ?? "");
      let body: Record<string, unknown> | null = null;
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        body = null;
      }
      c.recs.push({ request: (req.postDataJSON() ?? {}) as Record<string, unknown>, status: res.status(), response: body, ms: Date.now() - (started.get(key) ?? Date.now()) });
    }
  });
  c.flush = () => {
    const name = slug(`${info.project.name}-${info.title}`);
    c.recs.forEach((r, i) => {
      // De-identify: origin rounded to 0.01° in the stored transcript (same policy as API logs).
      const req = { ...r.request } as Record<string, unknown>;
      const o = req.origin as { lat: number; lon: number } | undefined;
      if (o) req.origin = { lat: Math.round(o.lat * 100) / 100, lon: Math.round(o.lon * 100) / 100, note: "rounded to 0.01°" };
      writeFileSync(path.join(RESP, `${name}-${i + 1}.json`), JSON.stringify({ test: info.title, project: info.project.name, ...r, request: req }, null, 2));
    });
    writeFileSync(
      path.join(CONSOLE, `${name}.json`),
      JSON.stringify({ test: info.title, project: info.project.name, consoleErrors: c.consoleErrors, pageErrors: c.pageErrors, failedRequests: c.failedRequests, httpErrors: c.httpErrors }, null, 2),
    );
  };
  return c;
}

export async function shot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: path.join(SHOTS, `${info.project.name}-${name}.png`) });
}

export async function waitForMap(page: Page) {
  await page.waitForFunction(() => window.__smartcity?.loaded === true && (window.__smartcity.sourceCounts.buildings ?? 0) > 0, null, {
    timeout: 60_000,
  });
}

export async function mapIdle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const map = window.__smartcityMap!;
        map.once("idle", () => resolve());
        map.triggerRepaint();
        setTimeout(resolve, 8000);
      }),
  );
}

export async function useDemoOrigin(page: Page) {
  await page.getByRole("button", { name: /Демо-точка/ }).click();
  await expect(page.getByTestId("origin-label")).toContainText("Демо-точка");
}

/** Origin from our own place base via /api/search (real lexical search over the DB). */
export async function originFromSearch(page: Page, q: string, name: string) {
  await page.getByLabel("Найти место в нашей базе").fill(q);
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const btn = page.getByRole("list", { name: "Результаты поиска" }).getByRole("button", { name: new RegExp(`^${esc}\\b`) }).first();
  await expect(btn).toBeVisible({ timeout: 20_000 });
  await btn.click();
  await expect(page.getByTestId("origin-label")).toHaveText(name);
}

export async function submit(page: Page) {
  await page.getByRole("button", { name: "Подобрать прогулку" }).click();
}

/** Wait for a terminal state of a live request: results or error card. */
export async function waitForOutcome(page: Page, timeout = LIVE_REC_TIMEOUT) {
  await expect(page.getByTestId("results").or(page.getByTestId("error-card"))).toBeVisible({ timeout });
}

export async function cardIds(page: Page) {
  return page.getByTestId("rec-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-place-id")));
}
export async function markerIds(page: Page) {
  return page.getByTestId("rec-marker").evaluateAll((els) => els.map((e) => e.getAttribute("data-place-id")));
}

export type Rec = {
  place_id: string;
  name: string;
  source: { url: string };
  coordinates: { lat: number; lon: number };
  opening_status: string;
  timing: { outbound_min: number; visit_min: number; return_min: number | null; buffer_min: number; total_min: number };
  distance: { meters: number; method: string };
  category: string;
  verified_features: { feature: string }[];
};

export function lastResponse(c: Collectors): { status: string; mode: string; recommendations: Rec[]; client_request_id?: string } & Record<string, unknown> {
  const r = c.recs.at(-1);
  expect(r, "a /api/recommend response was captured").toBeTruthy();
  expect(r!.status, `HTTP status of /api/recommend: ${JSON.stringify(r!.response).slice(0, 300)}`).toBe(200);
  return r!.response as never;
}

/** Invariants every live answer must satisfy (budget per alternative, server-built OSM links, ids). */
export function checkInvariants(resp: ReturnType<typeof lastResponse>, budget: number, returnToStart: boolean) {
  const ids = new Set<string>();
  for (const rec of resp.recommendations) {
    expect(ids.has(rec.place_id), "no duplicate place_id").toBe(false);
    ids.add(rec.place_id);
    const t = rec.timing;
    const sum = t.outbound_min + t.visit_min + (t.return_min ?? 0) + t.buffer_min;
    expect(sum, `total = outbound+visit+return+buffer for ${rec.place_id}`).toBe(t.total_min);
    expect(t.total_min).toBeLessThanOrEqual(budget);
    if (returnToStart) expect(t.return_min).toBe(t.outbound_min);
    else expect(t.return_min).toBeNull();
    expect(t.buffer_min).toBeGreaterThanOrEqual(Math.max(5, Math.ceil(0.1 * (t.outbound_min + (t.return_min ?? 0)))));
    expect(rec.source.url).toMatch(/^https:\/\/www\.openstreetmap\.org\/(node|way|relation)\/\d+$/);
    expect(rec.distance.method).toBe("geodesic");
  }
  expect(resp.recommendations.length).toBeLessThanOrEqual(3);
}
