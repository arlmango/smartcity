import type { Page, Route } from "@playwright/test";
import { expect } from "@playwright/test";
import type { RecommendRequest, RecommendResponse, ReadyResponse } from "../../src/lib/contracts";
import {
  buildings,
  coverage,
  coverageLayer,
  green,
  okResponse,
  readyOk,
  roads,
  searchResult,
  water,
} from "../fixtures/synthetic";

export type RecommendHandler = (
  body: RecommendRequest,
  n: number,
) => { status?: number; json: unknown; delayMs?: number } | Promise<{ status?: number; json: unknown; delayMs?: number }>;

export interface MockOptions {
  ready?: ReadyResponse | { status: number };
  recommend?: RecommendHandler;
  mapLayers?: Partial<Record<string, unknown>>;
}

export interface MockState {
  recommendBodies: RecommendRequest[];
  unmocked: string[];
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** Deterministic API stub (SYNTHETIC fixtures). Any unknown /api path fails the test. */
export async function mockApi(page: Page, opts: MockOptions = {}): Promise<MockState> {
  const state: MockState = { recommendBodies: [], unmocked: [] };
  const layers: Record<string, unknown> = {
    buildings: buildings(),
    roads: roads(),
    water: water(),
    green: green(),
    coverage: coverageLayer(),
    ...opts.mapLayers,
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === "/api/ready") {
      const r = opts.ready ?? readyOk;
      return "status" in r && typeof r.status === "number" ? json(route, { error: "down", message: "down" }, r.status) : json(route, r);
    }
    if (p === "/api/coverage") return json(route, coverage);
    if (p === "/api/health") return json(route, { status: "ok" });
    const m = p.match(/^\/api\/map\/(\w+)$/);
    if (m && m[1] && m[1] in layers) {
      const v = layers[m[1]];
      if (typeof v === "number") return json(route, { error: "x", message: "x" }, v);
      return json(route, v);
    }
    if (p === "/api/search") return json(route, { ...searchResult, query: url.searchParams.get("q") ?? "" });
    if (p === "/api/recommend" && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as RecommendRequest;
      state.recommendBodies.push(body);
      const handler: RecommendHandler = opts.recommend ?? ((b) => ({ json: okResponse(b.client_request_id) }));
      const res = await handler(body, state.recommendBodies.length);
      if (res.delayMs) await new Promise((r) => setTimeout(r, res.delayMs));
      try {
        return await json(route, res.json, res.status ?? 200);
      } catch {
        return; // request was aborted by the page (cancel)
      }
    }
    state.unmocked.push(`${route.request().method()} ${p}`);
    return json(route, { error: "unmocked", message: "unmocked in test" }, 500);
  });
  return state;
}

export async function waitForMap(page: Page) {
  await page.waitForFunction(() => window.__smartcity?.loaded === true && (window.__smartcity.sourceCounts.buildings ?? 0) > 0, null, {
    timeout: 30_000,
  });
}

/** Wait until the map is idle (all sources rendered). */
export async function mapIdle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const map = window.__smartcityMap!;
        if (map.loaded() && !map.isMoving()) {
          map.once("idle", () => resolve());
          map.triggerRepaint();
        } else map.once("idle", () => resolve());
        setTimeout(resolve, 5000);
      }),
  );
}

export async function useDemoOrigin(page: Page) {
  await page.getByRole("button", { name: /Демо-точка/ }).click();
  await expect(page.getByTestId("origin-label")).toContainText("Демо-точка");
}

export async function submit(page: Page) {
  await page.getByRole("button", { name: "Подобрать прогулку" }).click();
}

export type { RecommendResponse };
