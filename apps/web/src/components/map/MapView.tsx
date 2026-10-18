"use client";

import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MlMap, Marker } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import type { Recommendation } from "@/lib/contracts";
import type { Origin } from "@/lib/form";
import type { LayerResult, MapLayer } from "@/lib/mapData";
import {
  INITIAL_VIEW,
  OSM_ATTRIBUTION,
  SOURCE_IDS,
  buildMapStyle,
  pitchFor,
  viewModeVisibility,
  type ViewMode,
} from "@/lib/mapStyle";
import { displayName } from "../RecommendationCard";
import { MapControlButton } from "./MapControlButton";

export interface MapViewProps {
  layers: Partial<Record<MapLayer, LayerResult>>;
  origin: Origin | null;
  recs: Recommendation[];
  selectedId: string | null;
  focusSignal: number;
  fitSignal: number;
  pickActive: boolean;
  reducedMotion: boolean;
  viewMode: ViewMode;
  onViewModeChange: (m: ViewMode) => void;
  onPick: (lon: number, lat: number) => void;
  onSelectPlace: (id: string) => void;
  onFatal: (reason: string) => void;
  centerRequest: number;
  onCenter: (lon: number, lat: number) => void;
}

declare global {
  interface Window {
    __smartcityMap?: MlMap;
    __smartcity?: { loaded: boolean; viewMode: ViewMode; sourceCounts: Record<string, number>; markerIds: string[] };
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

function debugState(): NonNullable<Window["__smartcity"]> {
  if (!window.__smartcity) window.__smartcity = { loaded: false, viewMode: "3d", sourceCounts: {}, markerIds: [] };
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

  // Callbacks used inside map event handlers are read through refs (no map re-creation).
  const live = useRef(props);
  live.current = props;

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
      libRef.current = lib;
      try {
        map = new lib.Map({
          container: containerRef.current,
          style: buildMapStyle({ glyphsUrl: `${window.location.origin}/fonts/{fontstack}/{range}.pbf`, mode: live.current.viewMode }),
          center: INITIAL_VIEW.center,
          zoom: INITIAL_VIEW.zoom,
          pitch: pitchFor(live.current.viewMode) === 0 ? 0 : INITIAL_VIEW.pitch3d,
          bearing: INITIAL_VIEW.bearing,
          maxPitch: 70,
          minZoom: 11,
          maxZoom: 19,
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
      map.getCanvas().setAttribute("aria-label", "Интерактивная карта района EXPO / MEGA Silk Way");
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
        const msg = ev.error?.message ?? "map error";
        // Missing glyph ranges or a single tile error must not kill the map; log and continue.
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

  // ---------------------------------------------------------------- data
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    for (const id of SOURCE_IDS) {
      const src = map.getSource(id) as GeoJSONSource | undefined;
      const data = props.layers[id as MapLayer]?.data ?? EMPTY;
      src?.setData(data);
      debugState().sourceCounts[id] = data.features.length;
    }
  }, [loaded, props.layers]);

  // ---------------------------------------------------------------- 2D / 3D
  useEffect(() => {
    const map = mapRef.current;
    debugState().viewMode = props.viewMode;
    if (!map || !loaded) return;
    for (const [id, vis] of viewModeVisibility(props.viewMode)) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
    }
    map.easeTo({ pitch: pitchFor(props.viewMode), duration: props.reducedMotion ? 0 : 500 });
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
      markersRef.current.set(rec.place_id, { marker, el });
    });
    debugState().markerIds = props.recs.map((r) => r.place_id);
  }, [props.recs, loaded]);

  useEffect(() => {
    markersRef.current.forEach(({ el }, id) => el.setAttribute("aria-pressed", String(id === props.selectedId)));
  }, [props.selectedId, props.recs]);

  // ---------------------------------------------------------------- camera: fly to selected card
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !props.selectedId || props.focusSignal === 0) return;
    const rec = props.recs.find((r) => r.place_id === props.selectedId);
    if (!rec) return;
    const center: [number, number] = [rec.coordinates.lon, rec.coordinates.lat];
    const zoom = Math.max(map.getZoom(), 16.3);
    if (props.reducedMotion) map.jumpTo({ center, zoom });
    else map.flyTo({ center, zoom, duration: 900, essential: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focusSignal, loaded]);

  // ---------------------------------------------------------------- camera: fit results
  const fitResults = () => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib) return;
    const pts: Array<[number, number]> = props.recs.map((r) => [r.coordinates.lon, r.coordinates.lat]);
    if (props.origin) pts.push([props.origin.lon, props.origin.lat]);
    if (pts.length === 0) return;
    const duration = props.reducedMotion ? 0 : 700;
    if (pts.length === 1) {
      map.easeTo({ center: pts[0], zoom: Math.max(map.getZoom(), 16), duration });
      return;
    }
    const b = new lib.LngLatBounds(pts[0], pts[0]);
    pts.forEach((p) => b.extend(p));
    const w = containerRef.current?.clientWidth ?? 800;
    const pad = Math.min(80, Math.max(40, Math.round(w * 0.08)));
    map.fitBounds(b, { padding: { top: pad, bottom: pad + 30, left: pad, right: pad + 56 }, maxZoom: 17, duration });
  };
  useEffect(() => {
    if (loaded && props.fitSignal > 0) fitResults();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitSignal, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || props.centerRequest === 0) return;
    const c = map.getCenter();
    live.current.onCenter(c.lng, c.lat);
  }, [props.centerRequest, loaded]);

  const duration = props.reducedMotion ? 0 : 300;
  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="absolute inset-0" data-testid="map-canvas" />
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
      </div>
    </div>
  );
}
