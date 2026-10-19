import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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

/** A mocked recommendation answer. For the stream endpoint (used by the UI) `preliminary` is sent
 * before the final answer, and `streamError` replaces the final answer with an error event. */
export interface MockRecommend {
  status?: number;
  json: unknown;
  delayMs?: number;
  preliminary?: unknown;
  streamError?: { error: string; message: string };
}
export type RecommendHandler = (body: RecommendRequest, n: number) => MockRecommend | Promise<MockRecommend>;

export interface MockOptions {
  ready?: ReadyResponse | { status: number };
  recommend?: RecommendHandler;
  mapLayers?: Partial<Record<string, unknown>>;
  /** /api/basemap body, or an HTTP status to fail with. Default: SYNTHETIC info, satellite disabled. */
  basemap?: unknown;
}

export interface MockState {
  recommendBodies: RecommendRequest[];
  unmocked: string[];
  /** Every /api/tiles request as "set/z/x/y" (to check viewport loading). */
  tiles: string[];
  tileQueries: string[];
  mapLayerRequests: string[];
}

const TILES_DIR = path.resolve(__dirname, "../fixtures/tiles");

/** SYNTHETIC /api/basemap body (counts are invented for tests). */
export const basemapInfo = (satellite: boolean) => ({
  bbox: [71.15, 50.83, 71.85, 51.38],
  built_at: "2026-10-19T00:00:00+00:00",
  attribution: "© OpenStreetMap contributors (ODbL); base tiles: Protomaps Basemap",
  licenses: { osm: { license: "ODbL-1.0", attribution: "© OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright" } },
  coverage: { admin_boundary: "relation/3087155", boundary_area_km2: 793.6, boundary_inside_tiles: true },
  level_height_m: 3.2,
  default_height_m: 10,
  height_source: { height: 8, levels: 8, estimate: 7, default: 7 },
  stylised_landmarks: [{ osm: "way/SYNTH", centroid: [71.416, 51.0894] }],
  buildings: 30,
  tiles_version: "e2e0001",
  usage_mode: satellite ? "noncommercial" : "commercial",
  satellite: satellite
    ? {
        enabled: true,
        tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg"],
        maxzoom: 14,
        attribution: "EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024) · CC BY-NC-SA 4.0",
        license: "CC BY-NC-SA 4.0 (EOxCloudless 2018–2025, non-commercial use only)",
      }
    : { enabled: false, reason: "APP_USAGE_MODE=commercial" },
});

/** SYNTHETIC city boundary (a box around the fixture area). */
const boundaryFc = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[71.37, 51.06], [71.46, 51.06], [71.46, 51.12], [71.37, 51.12], [71.37, 51.06]]] } },
  ],
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** Deterministic API stub (SYNTHETIC fixtures). Any unknown /api path fails the test. */
export async function mockApi(page: Page, opts: MockOptions = {}): Promise<MockState> {
  const state: MockState = { recommendBodies: [], unmocked: [], tiles: [], tileQueries: [], mapLayerRequests: [] };
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
    if (p === "/api/basemap") {
      const b = opts.basemap ?? basemapInfo(false);
      return typeof b === "number" ? json(route, { error: "basemap_unavailable", message: "x" }, b) : json(route, b);
    }
    if (p === "/api/basemap/boundary") return json(route, boundaryFc);
    const t = p.match(/^\/api\/tiles\/(base|buildings)\/(\d+)\/(\d+)\/(\d+)$/);
    if (t) {
      state.tiles.push(`${t[1]}/${t[2]}/${t[3]}/${t[4]}`);
      state.tileQueries.push(url.search);
      const file = path.join(TILES_DIR, t[1]!, t[2]!, t[3]!, `${t[4]}.pbf`);
      if (!existsSync(file)) return route.fulfill({ status: 204 });
      return route.fulfill({ status: 200, contentType: "application/x-protobuf", body: readFileSync(file) });
    }
    const m = p.match(/^\/api\/map\/(\w+)$/);
    if (m) state.mapLayerRequests.push(m[1] ?? "");
    if (m && m[1] && m[1] in layers) {
      const v = layers[m[1]];
      if (typeof v === "number") return json(route, { error: "x", message: "x" }, v);
      return json(route, v);
    }
    if (p === "/api/search") return json(route, { ...searchResult, query: url.searchParams.get("q") ?? "" });
    if ((p === "/api/recommend" || p === "/api/recommend/stream") && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as RecommendRequest;
      state.recommendBodies.push(body);
      const handler: RecommendHandler = opts.recommend ?? ((b) => ({ json: okResponse(b.client_request_id) }));
      const res = await handler(body, state.recommendBodies.length);
      if (res.delayMs) await new Promise((r) => setTimeout(r, res.delayMs));
      try {
        if (p === "/api/recommend/stream" && (res.status ?? 200) === 200) {
          const lines: unknown[] = [];
          if (res.preliminary) lines.push({ event: "preliminary", response: res.preliminary });
          lines.push(
            res.streamError
              ? { event: "error", error: { ...res.streamError, request_id: null } }
              : { event: "final", response: res.json },
          );
          return await route.fulfill({
            status: 200,
            contentType: "application/x-ndjson",
            body: lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
          });
        }
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
  await page.waitForFunction(
    () => {
      const m = window.__smartcityMap;
      return window.__smartcity?.loaded === true && (window.__smartcity.sourceCounts.coverage ?? 0) > 0 && !!m && m.areTilesLoaded();
    },
    null,
    { timeout: 30_000 },
  );
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
  await expect(page.getByRole("button", { name: /Демо-точка/ })).toContainText("Это не ваше местоположение");
  await page.getByRole("button", { name: /Демо-точка/ }).click();
  await expect(page.getByTestId("origin-label")).toContainText("Демо-точка");
}

export async function submit(page: Page) {
  await page.getByRole("button", { name: "Подобрать прогулку" }).click();
}

export type { RecommendResponse };
