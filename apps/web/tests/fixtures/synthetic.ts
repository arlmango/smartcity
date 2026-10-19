/**
 * SYNTHETIC test fixtures — NOT real places, NOT real geometry.
 * Every name contains "SYNTHETIC"/"Тест". Coordinates are a tiny made-up layout
 * near the EXPO area only so that the map camera has something to render.
 * Never use these as live data (CLAUDE.md: fixtures only in tests/fixtures).
 */
import type { Feature, FeatureCollection, Polygon } from "geojson";
import type {
  CoverageResponse,
  ReadyResponse,
  RecommendResponse,
  Recommendation,
  SearchResponse,
} from "../../src/lib/contracts";

const C = { lon: 71.414, lat: 51.089 };
const AS_OF = "2026-10-01T00:00:00Z";

function rect(lon: number, lat: number, w: number, h: number): number[][] {
  return [
    [lon, lat],
    [lon + w, lat],
    [lon + w, lat + h],
    [lon, lat + h],
    [lon, lat],
  ];
}

export const coverageFeature: Feature<Polygon> = {
  type: "Feature",
  properties: { id: "synthetic-coverage", name: "SYNTHETIC тестовое покрытие" },
  geometry: { type: "Polygon", coordinates: [rect(71.4, 51.081, 0.028, 0.018)] },
};

const SOURCES = ["height", "levels", "default"] as const;

export function buildings(): FeatureCollection {
  const features: Feature[] = [];
  let n = 0;
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 5; j++) {
      const lon = C.lon - 0.006 + i * 0.0022;
      const lat = C.lat - 0.004 + j * 0.0016;
      const src = SOURCES[n % 3] as (typeof SOURCES)[number];
      features.push({
        type: "Feature",
        properties: {
          id: `way/9000${n}`,
          building: "yes",
          height_m: src === "default" ? 10 : 12 + (n % 7) * 6,
          min_height_m: 0,
          height_source: src,
          levels: src === "levels" ? 4 + (n % 5) : null,
        },
        geometry: { type: "Polygon", coordinates: [rect(lon, lat, 0.0012, 0.0007)] },
      });
      n++;
    }
  }
  // One courtyard building with an inner ring (hole) to exercise holes.
  features.push({
    type: "Feature",
    properties: { id: "way/9999", name: "SYNTHETIC двор", height_m: 30, min_height_m: 0, height_source: "height" },
    geometry: {
      type: "Polygon",
      coordinates: [rect(C.lon + 0.008, C.lat + 0.002, 0.003, 0.002), rect(C.lon + 0.009, C.lat + 0.0025, 0.001, 0.001).reverse()],
    },
  });
  return { type: "FeatureCollection", features };
}

export function roads(): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { id: "way/1", highway: "primary", name: "SYNTHETIC Тестовый проспект" },
        geometry: { type: "LineString", coordinates: [[71.401, C.lat - 0.0045], [71.427, C.lat - 0.0045]] },
      },
      {
        type: "Feature",
        properties: { id: "way/2", highway: "residential", name: "SYNTHETIC улица Тестовая" },
        geometry: { type: "LineString", coordinates: [[C.lon + 0.0068, 51.082], [C.lon + 0.0068, 51.098]] },
      },
      {
        type: "Feature",
        properties: { id: "way/3", highway: "footway" },
        geometry: { type: "LineString", coordinates: [[C.lon - 0.007, C.lat + 0.005], [C.lon + 0.006, C.lat + 0.0055]] },
      },
    ],
  };
}

export function green(): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { id: "way/50", kind: "park", name: "SYNTHETIC Тестовый парк" },
        geometry: { type: "Polygon", coordinates: [rect(C.lon - 0.012, C.lat + 0.0035, 0.005, 0.004)] },
      },
    ],
  };
}

export function water(): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { id: "way/60", kind: "pond", name: "SYNTHETIC пруд" },
        geometry: { type: "Polygon", coordinates: [rect(C.lon - 0.0105, C.lat + 0.0045, 0.0015, 0.001)] },
      },
    ],
  };
}

export function coverageLayer(): FeatureCollection {
  return { type: "FeatureCollection", features: [coverageFeature] };
}

export const coverage: CoverageResponse = {
  type: "FeatureCollection",
  features: [coverageFeature as unknown as Record<string, unknown>],
  dataset_version: "synthetic-fixture-1",
  place_count: 3,
  freshness: AS_OF,
  updated_at: "2026-10-02T06:00:00Z",
  bbox: [71.4, 51.081, 71.428, 51.099],
  default_origin: { lat: 51.0889, lon: 71.4152 },
  default_origin_label: "EXPO (SYNTHETIC)",
};

export const readyOk: ReadyResponse = {
  ready: true,
  components: {
    db: { status: "ok", detail: "synthetic" },
    data: { status: "ok", detail: "synthetic" },
    map: { status: "ok", detail: "synthetic" },
    embeddings: { status: "ok", detail: "synthetic" },
    llm: { status: "ok", detail: "synthetic" },
    routing: { status: "not_configured", detail: "synthetic" },
  },
};

export const readyLlmDown: ReadyResponse = {
  ready: true,
  components: { ...readyOk.components, llm: { status: "unavailable", detail: "synthetic: provider down" } },
};

function rec(over: Partial<Recommendation> & Pick<Recommendation, "place_id" | "name" | "category" | "category_label" | "coordinates">): Recommendation {
  return {
    route: null,
    name_is_generic: false,
    address: null,
    reason: "SYNTHETIC: объяснение из тестовой фикстуры.",
    reason_source: "llm",
    activity_suggestion: "SYNTHETIC: идея активности (оценка).",
    distance: { meters: 420, method: "geodesic", note: "По прямой; реальный путь по улицам длиннее" },
    timing: { outbound_min: 9, visit_min: 15, return_min: 9, buffer_min: 5, total_min: 38, estimated: true, method: "synthetic" },
    opening_status: "unknown",
    opening_hours_raw: null,
    opening_note: "Часы не указаны в OSM",
    as_of: AS_OF,
    verified_features: [],
    unknown_features: ["socket"],
    negative_features: [],
    website: null,
    source: {
      name: "OpenStreetMap",
      osm_type: "node",
      osm_id: 1,
      url: "https://www.openstreetmap.org/node/1",
      license: "ODbL-1.0",
      fetched_at: AS_OF,
      source_updated_at: null,
    },
    evidence: [],
    ...over,
  };
}

export const recA = rec({
  place_id: "synthetic-cafe-1",
  name: "SYNTHETIC Кафе «Тест»",
  category: "cafe",
  category_label: "Кафе",
  coordinates: { lat: 51.0895, lon: 71.4165 },
  opening_status: "open",
  opening_hours_raw: "Mo-Su 08:00-22:00",
  opening_note: "Открыто на всё время визита (по OSM)",
  verified_features: [{ feature: "wifi", value: true, basis: "tag", evidence: "OSM: internet_access=wlan" }],
  unknown_features: ["socket", "wheelchair"],
  website: "https://example.org/synthetic-cafe",
  source: {
    name: "OpenStreetMap",
    osm_type: "node",
    osm_id: 101,
    url: "https://www.openstreetmap.org/node/101",
    license: "ODbL-1.0",
    fetched_at: AS_OF,
    source_updated_at: null,
  },
  evidence: [
    { field: "internet_access", source_value: "wlan", source_url: "https://www.openstreetmap.org/node/101", license: "ODbL-1.0", collected_at: AS_OF },
  ],
});

export const recB = rec({
  place_id: "synthetic-playground-2",
  name: "Детская площадка",
  name_is_generic: true,
  category: "playground",
  category_label: "Детская площадка",
  coordinates: { lat: 51.088, lon: 71.412 },
  distance: { meters: 260, method: "geodesic", note: "По прямой; реальный путь по улицам длиннее" },
  timing: { outbound_min: 6, visit_min: 20, return_min: 6, buffer_min: 5, total_min: 37, estimated: true, method: "synthetic" },
  verified_features: [{ feature: "kids", value: true, basis: "category_rule", evidence: "leisure=playground" }],
  negative_features: [{ feature: "indoor", value: false, basis: "category_rule", evidence: "Площадка на улице" }],
  unknown_features: [],
});

export const recC = rec({
  place_id: "synthetic-museum-3",
  name: "SYNTHETIC Музей тестов",
  category: "culture",
  category_label: "Культура",
  coordinates: { lat: 51.087, lon: 71.418 },
  distance: { meters: 610, method: "geodesic", note: "По прямой; реальный путь по улицам длиннее" },
  timing: { outbound_min: 12, visit_min: 20, return_min: 12, buffer_min: 5, total_min: 49, estimated: true, method: "synthetic" },
});

const providers = {
  llm_provider: "synthetic",
  llm_model: "synthetic",
  embedding_provider: "synthetic",
  embedding_model: "synthetic",
  embedding_dim: 3,
  routing: "none" as const,
};

export function okResponse(clientRequestId: string, recs: Recommendation[] = [recA, recB, recC]): RecommendResponse {
  return {
    request_id: `srv-${clientRequestId.slice(0, 8)}`,
    client_request_id: clientRequestId,
    status: "ok",
    mode: "live_rag",
    dataset_version: "synthetic-fixture-1",
    constraints_applied: {
      hard: [
        { kind: "time_budget", value: 60, source: "ui", label: "Не больше 60 мин" },
        { kind: "return_to_start", value: true, source: "ui", label: "Вернуться к старту" },
        { kind: "walking_only", value: true, source: "ui", label: "Только пешком" },
      ],
      preferences: ["кофе"],
      interpreted_query: "SYNTHETIC: кофе рядом",
    },
    recommendations: recs,
    message: "SYNTHETIC: нашли три варианта.",
    warnings: [],
    suggested_relaxations: [],
    route: null,
    plan: null,
    plan_note: null,
    providers,
    timings_ms: { total: 1200 },
  };
}

export function retrievalOnlyResponse(clientRequestId: string): RecommendResponse {
  const base = okResponse(clientRequestId, [{ ...recA, reason: null, reason_source: "rules", activity_suggestion: null }]);
  return {
    ...base,
    status: "degraded",
    mode: "retrieval_only",
    message: "SYNTHETIC: показаны найденные места.",
    warnings: [{ code: "llm_unavailable", message: "ИИ временно недоступен — показаны найденные места без сгенерированных объяснений" }],
  };
}

export function noMatchResponse(clientRequestId: string): RecommendResponse {
  const base = okResponse(clientRequestId, []);
  return {
    ...base,
    status: "no_match",
    message: "SYNTHETIC: нет мест, где розетки подтверждены.",
    suggested_relaxations: [
      {
        code: "socket_to_preference",
        message: "Показать кафе, где наличие розеток не подтверждено",
        patch: {
          required_features: [],
          preferred_features: ["socket"],
          include_categories: [],
          exclude_categories: [],
          must_be_open: false,
          max_distance_m: null,
          exclude_place_ids: [],
          dropped_text_constraints: [],
        },
      },
    ],
  };
}

export function clarificationResponse(clientRequestId: string): RecommendResponse {
  return { ...okResponse(clientRequestId, []), status: "needs_clarification", message: "SYNTHETIC: «только внутри» и «только парк» противоречат друг другу. Что важнее?" };
}

export const searchResult: SearchResponse = {
  query: "тест",
  method: "lexical(name,address,category)",
  items: [
    {
      place_id: recC.place_id,
      name: recC.name,
      name_is_generic: false,
      category: "culture",
      category_label: "Культура",
      coordinates: recC.coordinates,
      address: "SYNTHETIC адрес",
    },
  ],
};

export const XSS_NAME = '<img src=x onerror="window.__xss=1">SYNTHETIC';
