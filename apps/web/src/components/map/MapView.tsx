"use client";

import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MlMap, Marker } from "maplibre-gl";
import { MAPLIBRE_WORKER_URL } from "@/lib/mapWorker";
import { useEffect, useRef, useState } from "react";
import type { Recommendation } from "@/lib/contracts";
import type { Origin } from "@/lib/form";
import {
  BASEMAP_LABEL,
  CITY_BOUNDS,
  INITIAL_VIEW,
  OSM_ATTRIBUTION,
  buildMapStyle,
  effectiveVariant,
  pitchFor,
  viewModeVisibility,
  type BasemapVariant,
  type SatelliteSource,
  type ViewMode,
} from "@/lib/mapStyle";
import { displayName } from "../RecommendationCard";
import { useWalkingRoute } from "./useWalkingRoute";
import { routeCoordinates, routeFeatures, type MapRoute } from "@/lib/walkingRoute";
import { MapControlButton } from "./MapControlButton";

export interface MapViewProps {
  route: MapRoute | null;
  coverage: FeatureCollection | undefined;
  boundary: FeatureCollection | undefined;
  origin: Origin | null;
  recs: Recommendation[];
  selectedId: string | null;
  focusSignal: number;
  fitSignal: number;
  coverageFitSignal: number;
  pickActive: boolean;
  reducedMotion: boolean;
  viewMode: ViewMode;
  onViewModeChange: (m: ViewMode) => void;
  variant: BasemapVariant;
  satellite: SatelliteSource | null;
  tilesVersion: string | null;
  onVariantChange: (v: BasemapVariant) => void;
  /** A satellite tile failed (host down, blocked); the vector map keeps working. */
  onSatelliteError?: () => void;
  onPick: (lon: number, lat: number) => void;
  onSelectPlace: (id: string) => void;
  onFatal: (reason: string) => void;
  centerRequest: number;
  onCenter: (lon: number, lat: number) => void;
}

declare global {
  interface Window {
    __smartcityMap?: MlMap;
    __smartcity?: {
      loaded: boolean;
      viewMode: ViewMode;
      variant: BasemapVariant;
      sourceCounts: Record<string, number>;
      markerIds: string[];
    };
  }
}

export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** Stacking order for result markers: lower result number above higher; selected marker above all. */
export function markerZ(index: number, selected: boolean): number {
  return selected ? 1000 : 100 - index;
}

/** Bounding box [[w, s], [e, n]] of polygon features, or null. */
export function featureBounds(fc: FeatureCollection | undefined): [[number, number], [number, number]] | null {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity;
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") {
      w = Math.min(w, c[0]);
      e = Math.max(e, c[0]);
      s = Math.min(s, c[1]);
      n = Math.max(n, c[1]);
    } else if (Array.isArray(c)) c.forEach(visit);
  };
  for (const f of fc?.features ?? []) if (f.geometry && "coordinates" in f.geometry) visit(f.geometry.coordinates);
  return Number.isFinite(w) ? [[w, s], [e, n]] : null;
}

function debugState(): NonNullable<Window["__smartcity"]> {
  if (!window.__smartcity) window.__smartcity = { loaded: false, viewMode: "3d", variant: "scheme", sourceCounts: {}, markerIds: [] };
  return window.__smartcity;
}

export function MapView(props: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const libRef = useRef<typeof import("maplibre-gl") | null>(null);
  const markersRef = useRef<Map<string, { marker: Marker; el: HTMLButtonElement }>>(new Map());
  const originMarkerRef = useRef<Marker | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const [bearing, setBearing] = useState(INITIAL_VIEW.bearing);

  useWalkingRoute(mapRef, libRef, loaded, props.route, props.reducedMotion);

  // Callbacks used inside map event handlers are read through refs (no map re-creation).
  const live = useRef(props);
  live.current = props;

  const styleFor = (p: MapViewProps) =>
    buildMapStyle({
      glyphsUrl: `${window.location.origin}/fonts/{fontstack}/{range}.pbf`,
      tilesUrl: `${window.location.origin}/api/tiles`,
      mode: p.viewMode,
      variant: p.variant,
      satellite: p.satellite,
      tilesVersion: p.tilesVersion,
      coverage: p.coverage ?? EMPTY,
      boundary: p.boundary ?? EMPTY,
    });

  // ---------------------------------------------------------------- create map once
  useEffect(() => {
    let cancelled = false;
    let map: MlMap | null = null;
    if (!webglAvailable()) {
      props.onFatal("WebGL недоступен в этом браузере");
      return;
    }
    const slowTimer = setTimeout(() => setSlow(true), 20_000);
    (async () => {
      const lib = await import("maplibre-gl");
      if (cancelled || !containerRef.current) return;
      // MapLibre 6 runs its tiles/GeoJSON worker from a separate module file, served same-origin.
      lib.setWorkerUrl(MAPLIBRE_WORKER_URL);
      libRef.current = lib;
      try {
        map = new lib.Map({
          container: containerRef.current,
          style: styleFor(live.current),
          center: INITIAL_VIEW.center,
          zoom: INITIAL_VIEW.zoom,
          pitch: pitchFor(live.current.viewMode) === 0 ? 0 : INITIAL_VIEW.pitch3d,
          bearing: INITIAL_VIEW.bearing,
          maxPitch: 70,
          minZoom: 9.5,
          maxZoom: 19,
          // The base map covers Astana (checked against its OSM boundary) — not the whole world.
          maxBounds: [
            [CITY_BOUNDS[0] - 0.12, CITY_BOUNDS[1] - 0.08],
            [CITY_BOUNDS[2] + 0.12, CITY_BOUNDS[3] + 0.08],
          ],
          attributionControl: false,
          dragRotate: true,
          touchPitch: true,
          cooperativeGestures: false,
          fadeDuration: live.current.reducedMotion ? 0 : 300,
        });
      } catch (e) {
        live.current.onFatal(e instanceof Error ? e.message : "Не удалось создать карту");
        return;
      }
      mapRef.current = map;
      window.__smartcityMap = map;
      map.addControl(new lib.AttributionControl({ compact: false, customAttribution: OSM_ATTRIBUTION }), "bottom-right");
      map.addControl(new lib.ScaleControl({ unit: "metric", maxWidth: 120 }), "bottom-left");
      map.getCanvas().setAttribute("aria-label", "Интерактивная карта Астаны; места для прогулки — в зоне рекомендаций (район EXPO / MEGA Silk Way)");
      map.getCanvas().setAttribute("role", "application");
      // Keyboard on the canvas (arrows / +/-) is MapLibre's built-in handler.

      map.on("load", () => {
        if (cancelled) return;
        clearTimeout(slowTimer);
        setSlow(false);
        setLoaded(true);
        debugState().loaded = true;
      });
      map.on("rotate", () => setBearing(map?.getBearing() ?? 0));
      map.on("error", (ev) => {
        if ((ev as { sourceId?: string }).sourceId === "satellite") live.current.onSatelliteError?.();
        const msg = ev.error?.message ?? "map error";
        // A missing glyph range or a single tile error must not kill the map; log and continue.
        console.warn("[map]", msg);
      });
      map.getCanvas().addEventListener("webglcontextlost", () => live.current.onFatal("Потерян контекст WebGL"));
      map.on("click", (ev) => {
        const target = ev.originalEvent?.target as HTMLElement | null;
        if (target?.closest?.(".maplibregl-marker")) return;
        if (live.current.pickActive) live.current.onPick(ev.lngLat.lng, ev.lngLat.lat);
      });
    })().catch((e: unknown) => live.current.onFatal(e instanceof Error ? e.message : "Не удалось загрузить карту"));

    const markers = markersRef.current;
    const ro = new ResizeObserver(() => mapRef.current?.resize());
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
      ro.disconnect();
      markers.forEach(({ marker }) => marker.remove());
      markers.clear();
      originMarkerRef.current?.remove();
      originMarkerRef.current = null;
      map?.remove();
      mapRef.current = null;
      if (window.__smartcityMap === map) delete window.__smartcityMap;
      if (window.__smartcity) window.__smartcity.loaded = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the map is created once per mount
  }, []);

  // ---------------------------------------------------------------- base map variant (hybrid / scheme)
  const shownVariant = effectiveVariant(props.variant, props.satellite);
  useEffect(() => {
    const map = mapRef.current;
    debugState().variant = shownVariant;
    if (!map || !loaded) return;
    // A style diff swaps only what changed (satellite source, paint values); markers are DOM and stay.
    map.setStyle(styleFor(live.current), { diff: true });
  }, [shownVariant, props.tilesVersion, loaded]);

  // ---------------------------------------------------------------- data
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const data: Record<string, FeatureCollection> = { coverage: props.coverage ?? EMPTY, boundary: props.boundary ?? EMPTY };
    for (const [id, fc] of Object.entries(data)) {
      (map.getSource(id) as GeoJSONSource | undefined)?.setData(fc);
      debugState().sourceCounts[id] = fc.features.length;
    }
  }, [loaded, props.coverage, props.boundary]);

  // ---------------------------------------------------------------- 2D / 3D
  useEffect(() => {
    const map = mapRef.current;
    debugState().viewMode = props.viewMode;
    if (!map || !loaded) return;
    for (const [id, vis] of viewModeVisibility(props.viewMode)) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
    }
    map.easeTo({ pitch: pitchFor(props.viewMode), duration: props.reducedMotion ? 0 : 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.viewMode, loaded]);

  // ---------------------------------------------------------------- pick-mode cursor
  useEffect(() => {
    containerRef.current?.classList.toggle("sc-pick-mode", props.pickActive);
  }, [props.pickActive]);

  // ---------------------------------------------------------------- origin marker
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib || !loaded) return;
    originMarkerRef.current?.remove();
    originMarkerRef.current = null;
    if (!props.origin) return;
    const el = document.createElement("div");
    el.className = "sc-origin-marker";
    el.setAttribute("data-testid", "origin-marker");
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", `Точка старта: ${props.origin.label}`);
    const dot = document.createElement("div");
    dot.className = "sc-origin-dot";
    const label = document.createElement("div");
    label.className = "sc-origin-label";
    label.textContent = "Старт";
    el.append(dot, label);
    originMarkerRef.current = new lib.Marker({ element: el, anchor: "top", offset: [0, -11] })
      .setLngLat([props.origin.lon, props.origin.lat])
      .addTo(map);
  }, [props.origin, loaded]);

  // ---------------------------------------------------------------- result markers
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib || !loaded) return;
    markersRef.current.forEach(({ marker }) => marker.remove());
    markersRef.current.clear();
    props.recs.forEach((rec, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "sc-marker";
      el.textContent = String(i + 1); // textContent: names never become HTML
      el.setAttribute("data-place-id", rec.place_id);
      el.setAttribute("data-testid", "rec-marker");
      el.setAttribute("aria-label", `${i + 1}. ${displayName(rec)} — открыть карточку`);
      el.setAttribute("aria-pressed", String(live.current.selectedId === rec.place_id));
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        live.current.onSelectPlace(rec.place_id);
      });
      const marker = new lib.Marker({ element: el, anchor: "center" }).setLngLat([rec.coordinates.lon, rec.coordinates.lat]).addTo(map);
      // Places can be metres apart (e.g. inside one mall): lower numbers stay on top, the selected one above all.
      el.style.zIndex = String(markerZ(i, live.current.selectedId === rec.place_id));
      markersRef.current.set(rec.place_id, { marker, el });
    });
    debugState().markerIds = props.recs.map((r) => r.place_id);
  }, [props.recs, loaded]);

  useEffect(() => {
    let i = 0;
    markersRef.current.forEach(({ el }, id) => {
      el.setAttribute("aria-pressed", String(id === props.selectedId));
      el.style.zIndex = String(markerZ(i++, id === props.selectedId));
    });
  }, [props.selectedId, props.recs]);

  // ---------------------------------------------------------------- camera: fly to selected card
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || props.focusSignal === 0) return;
    // A shown route (single place or the whole plan) is framed as a whole.
    if (props.route) {
      const bounds = featureBounds(routeFeatures(props.route));
      if (bounds) map.fitBounds(bounds, { padding: padding(), maxZoom: 17, duration: props.reducedMotion ? 0 : 900, essential: false });
      return;
    }
    const rec = props.recs.find((r) => r.place_id === props.selectedId);
    if (!rec) return;
    const center: [number, number] = [rec.coordinates.lon, rec.coordinates.lat];
    const zoom = Math.max(map.getZoom(), 16.3);
    if (props.reducedMotion) map.jumpTo({ center, zoom });
    // flyTo is interrupted by any user drag/zoom (MapLibre stops the animation on input).
    else map.flyTo({ center, zoom, duration: 1100, curve: 1.3, essential: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focusSignal, loaded]);

  // ---------------------------------------------------------------- camera: fit results / coverage
  const padding = () => {
    const w = containerRef.current?.clientWidth ?? 800;
    // Padding applies to marker centres; markers are 44 px wide, so keep at least their radius + a gap.
    const pad = Math.min(80, Math.max(56, Math.round(w * 0.08)));
    return { top: pad + 40, bottom: pad + 30, left: pad, right: pad + 56 };
  };
  const fitResults = () => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib) return;
    const pts: Array<[number, number]> = props.recs.map((r) => [r.coordinates.lon, r.coordinates.lat]);
    pts.push(...routeCoordinates(props.route));
    if (props.origin) pts.push([props.origin.lon, props.origin.lat]);
    if (pts.length === 0) return;
    const duration = props.reducedMotion ? 0 : 900;
    if (pts.length === 1) {
      map.easeTo({ center: pts[0], zoom: Math.max(map.getZoom(), 16), duration });
      return;
    }
    const b = new lib.LngLatBounds(pts[0], pts[0]);
    pts.forEach((p) => b.extend(p));
    map.fitBounds(b, { padding: padding(), maxZoom: 17, duration });
  };
  useEffect(() => {
    if (loaded && props.fitSignal > 0) fitResults();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitSignal, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    const bounds = featureBounds(props.coverage);
    if (!map || !loaded || props.coverageFitSignal === 0 || !bounds) return;
    map.fitBounds(bounds, { padding: padding(), maxZoom: 15.5, duration: props.reducedMotion ? 0 : 1000, pitch: pitchFor(props.viewMode) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.coverageFitSignal, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || props.centerRequest === 0) return;
    const c = map.getCenter();
    live.current.onCenter(c.lng, c.lat);
  }, [props.centerRequest, loaded]);

  const duration = props.reducedMotion ? 0 : 300;
  const variants: BasemapVariant[] = props.satellite ? ["hybrid", "scheme"] : [];
  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="absolute inset-0" data-testid="map-canvas" />
      {props.route && (
        <div data-testid="route-legend" className="pointer-events-none absolute left-3 top-16 max-w-[220px] rounded-control bg-white/95 p-2 text-xs shadow-control">
          <p className="font-bold">{props.route.kind === "plan" ? "План прогулки" : "Пеший путь"}</p>
          <p>
            {props.route.kind === "plan" ? `Остановки ${props.route.marks.map((m) => m.letter).join(" → ")}` : "А → Б"} · зелёная линия
            {props.route.hasReturn ? " · обратно: фиолетовый пунктир" : ""}
          </p>
          <p>Время приблизительное. Подход к месту не проверен.</p>
        </div>
      )}
      {!loaded && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center" role="status">
          <p className="rounded-control bg-white/90 px-4 py-2 text-sm font-semibold shadow-control">
            {slow ? "Карта загружается дольше обычного…" : "Загружаем карту…"}
          </p>
        </div>
      )}
      {slow && !loaded && (
        <div className="absolute inset-x-0 bottom-16 flex justify-center">
          <button type="button" className="sc-btn-dark" onClick={() => props.onFatal("Карта не загрузилась за 20 секунд")}>
            Открыть простую карту
          </button>
        </div>
      )}
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-2" role="group" aria-label="Управление картой">
        <MapControlButton label="Приблизить" onClick={() => mapRef.current?.zoomIn({ duration })}>
          +
        </MapControlButton>
        <MapControlButton label="Отдалить" onClick={() => mapRef.current?.zoomOut({ duration })}>
          −
        </MapControlButton>
        <MapControlButton
          label="3D-здания"
          pressed={props.viewMode === "3d"}
          onClick={() => props.onViewModeChange(props.viewMode === "3d" ? "2d" : "3d")}
          testId="toggle-3d"
        >
          <span className="text-[13px] font-extrabold">{props.viewMode === "3d" ? "3D" : "2D"}</span>
        </MapControlButton>
        <MapControlButton label="На север" onClick={() => mapRef.current?.resetNorth({ duration })}>
          <span aria-hidden style={{ display: "inline-block", transform: `rotate(${-bearing}deg)` }}>
            ↑
          </span>
        </MapControlButton>
        <MapControlButton
          label="Показать результаты"
          onClick={fitResults}
          disabled={props.recs.length === 0 && !props.origin}
          testId="fit-results"
        >
          <svg aria-hidden viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </svg>
        </MapControlButton>
        {variants.length > 1 && (
          // Phones: one toggle in the control column (the bottom edge is taken by attribution).
          <div className="sm:hidden">
            <MapControlButton
              label={shownVariant === "hybrid" ? "Подложка: гибрид (спутник на обзоре). Переключить на схему" : "Подложка: схема. Переключить на гибрид"}
              pressed={shownVariant === "hybrid"}
              onClick={() => props.onVariantChange(shownVariant === "hybrid" ? "scheme" : "hybrid")}
              testId="basemap-toggle"
            >
              <svg aria-hidden viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                <path d="M12 3 2 8l10 5 10-5-10-5Z" />
                <path d="m2 13 10 5 10-5" />
              </svg>
            </MapControlButton>
          </div>
        )}
      </div>
      {variants.length > 1 && (
        <div
          className="absolute bottom-9 right-3 z-10 flex rounded-control border border-stroke bg-white/95 p-1 shadow-control max-sm:hidden"
          role="group"
          aria-label="Подложка карты"
          data-testid="basemap-switch"
        >
          {variants.map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={shownVariant === v}
              title={v === "hybrid" ? "Спутник EOxCloudless на обзоре города, схема на уровне улиц (запросит согласие)" : "Векторная схема по данным OSM"}
              className="min-h-[44px] min-w-[44px] rounded-[9px] px-3 text-[13px] font-semibold text-graphite aria-pressed:bg-graphite aria-pressed:text-white"
              onClick={() => props.onVariantChange(v)}
            >
              {BASEMAP_LABEL[v]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
