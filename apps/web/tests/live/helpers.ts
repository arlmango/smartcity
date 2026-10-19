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
  /** Number of "preliminary" stream events seen (places shown before the model finished). */
  preliminaryCount: number;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  httpErrors: string[];
  flush: () => void;
  page: Page;
  /** client_request_id of the last POST to /api/recommend*. */
  lastRequestId: string | null;
}

/** Attach evidence collectors to the page; call `flush()` at the end of the test. */
export function collect(page: Page, info: TestInfo): Collectors {
  const c: Collectors = { recs: [], preliminaryCount: 0, consoleErrors: [], pageErrors: [], failedRequests: [], httpErrors: [], flush: () => {}, page, lastRequestId: null };
  const started = new Map<string, number>();
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") c.consoleErrors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => c.pageErrors.push(e.message));
  const byKey = new Map<string, Captured>();
  page.on("request", (r) => {
    if (r.url().includes("/api/recommend") && r.method() === "POST") {
      const key = r.url() + (r.postData() ?? "");
      started.set(key, Date.now());
      c.lastRequestId = ((r.postDataJSON() ?? {}) as { client_request_id?: string }).client_request_id ?? null;
      // Recorded synchronously at send time; status/response are filled in when the answer is done.
      const entry: Captured = { request: (r.postDataJSON() ?? {}) as Record<string, unknown>, status: 0, response: null, ms: 0 };
      byKey.set(key, entry);
      c.recs.push(entry);
    }
  });
  page.on("requestfailed", (r) => c.failedRequests.push(`${r.method()} ${new URL(r.url()).pathname} — ${r.failure()?.errorText ?? "?"}`));
  page.on("response", async (res) => {
    const url = new URL(res.url());
    if (res.status() >= 400) c.httpErrors.push(`${res.request().method()} ${url.pathname} → ${res.status()}`);
    if ((url.pathname === "/api/recommend" || url.pathname === "/api/recommend/stream") && res.request().method() === "POST") {
      const req = res.request();
      const key = req.url() + (req.postData() ?? "");
      let body: Record<string, unknown> | null = null;
      try {
        if (url.pathname.endsWith("/stream") && res.status() === 200) {
          // The streamed body is not exposed by Playwright: wait for the stream to finish, then read
          // what the app received (window.__smartcityRecommend, filled by the real client code).
          await res.finished();
          const cid = ((req.postDataJSON() ?? {}) as { client_request_id?: string }).client_request_id ?? "";
          const got = await page.evaluate((id) => {
            const d = (window as unknown as { __smartcityRecommend?: { preliminary: Record<string, unknown>; final: Record<string, unknown>; errors: Record<string, string> } }).__smartcityRecommend;
            return d ? { pre: id in d.preliminary, fin: d.final[id] ?? null, err: d.errors[id] ?? null } : null;
          }, cid);
          if (got?.pre) c.preliminaryCount += 1;
          body = (got?.fin as Record<string, unknown> | null) ?? (got?.err ? { error: got.err } : null);
        } else {
          body = (await res.json()) as Record<string, unknown>;
        }
      } catch {
        body = null; // cancelled stream: no final answer
      }
      const entry = byKey.get(key);
      if (entry) {
        entry.status = res.status();
        entry.response = body;
        entry.ms = Date.now() - (started.get(key) ?? Date.now());
      }
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
  await page.waitForFunction(
    () => {
      const m = window.__smartcityMap;
      return window.__smartcity?.loaded === true && (window.__smartcity.sourceCounts.coverage ?? 0) > 0 && !!m && m.areTilesLoaded();
    },
    null,
    { timeout: 60_000 },
  );
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
  // Preliminary places are rendered in "results" too, while "progress" is still shown.
  await expect(page.getByTestId("progress")).toHaveCount(0, { timeout });
  await expect(page.getByTestId("results").or(page.getByTestId("error-card"))).toBeVisible({ timeout: 10_000 });
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

export type LiveResponse = { status: string; mode: string; recommendations: Rec[]; client_request_id?: string } & Record<string, unknown>;

export async function lastResponse(c: Collectors): Promise<LiveResponse> {
  // The final answer of the last request as the real client received it (streamed bodies are not
  // exposed by Playwright); waits until the client has recorded a final answer or an error.
  expect(c.lastRequestId, "a /api/recommend request was sent").toBeTruthy();
  const handle = await c.page.waitForFunction(
    (id: string) => {
      const d = (window as unknown as { __smartcityRecommend?: { final: Record<string, unknown>; errors: Record<string, string> } }).__smartcityRecommend;
      if (!d) return null;
      if (id in d.final) return { final: d.final[id] };
      if (id in d.errors) return { error: d.errors[id] };
      return null;
    },
    c.lastRequestId ?? "",
    { timeout: 30_000 },
  );
  const got = (await handle.jsonValue()) as { final?: Record<string, unknown>; error?: string };
  expect(got.error, `recommend request failed in the client: ${got.error}`).toBeUndefined();
  return got.final as never;
}

/** Invariants every live answer must satisfy (budget per alternative, server-built OSM links, ids). */
export function checkInvariants(resp: LiveResponse, budget: number, returnToStart: boolean) {
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
