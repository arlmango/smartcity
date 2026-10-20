"use client";
import type { FeatureCollection } from "geojson";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Relaxation } from "@/lib/contracts";
import {
  REFINEMENT_LABEL,
  buildRequest,
  initialForm,
  refineConstraints,
  type Origin,
  type RefinementKind,
  type WalkForm,
} from "@/lib/form";
import { useBasemap, useBoundary, useCoverage, useMapLayers, useMediaQuery, useOnline, useReady, useRecommend, useReducedMotion } from "@/lib/hooks";
import { INTEREST_LABEL } from "@/lib/labels";
import { heightStats, pointInCoverage } from "@/lib/mapData";
import { describeProviders, hasExternalProvider } from "@/lib/providers";
import type { BasemapVariant, SatelliteSource, ViewMode } from "@/lib/mapStyle";
import { describeRemoval, withoutStop, type PlanRemoval } from "@/lib/plan";
import { newClientRequestId } from "@/lib/recommendState";
import { mapRouteOf, mapRouteOfPlan } from "@/lib/walkingRoute";
import { ErrorCard } from "./ErrorCard";
import { Header } from "./Header";
import { FallbackMap } from "./map/FallbackMap";
import { HeightLegend } from "./map/HeightLegend";
import { MapView } from "./map/MapView";
import { SatelliteConsent } from "./map/SatelliteConsent";
import { ProgressPanel } from "./ProgressPanel";
import { ResultsPanel } from "./ResultsPanel";
import { StatusBanners } from "./StatusBanners";
import { WalkFormPanel } from "./WalkFormPanel";
type Sheet = "collapsed" | "half" | "full";
const OUTSIDE_DETAIL =
  "Карта показывает всю Астану, но база мест для прогулок пока собрана только в районе EXPO / MEGA Silk Way (зелёная пунктирная зона). Выберите точку внутри неё или демо-точку.";
const OUTSIDE_MSG = `Вне зоны рекомендаций. ${OUTSIDE_DETAIL}`;
export function App() {
  const online = useOnline();
  const reducedMotion = useReducedMotion();
  const isDesktop = useMediaQuery("(min-width: 1024px)", true);
  const ready = useReady();
  const coverage = useCoverage();
  const [mapFatal, setMapFatal] = useState<string | null>(null);
  // The WebGL map draws the city from vector tiles; full GeoJSON layers only for the fallback map.
  const map = useMapLayers(!!mapFatal);
  const basemap = useBasemap();
  const boundary = useBoundary(!mapFatal);
  const satellite: SatelliteSource | null = useMemo(() => {
    const s = basemap.data?.satellite;
    return s && s.enabled ? { tiles: s.tiles, maxzoom: s.maxzoom, attribution: s.attribution } : null;
  }, [basemap.data]);
  // Always start on the scheme: no request to the satellite host until the viewer explicitly enables
  // the hybrid after the consent notice. Neither the choice nor the consent is stored between visits.
  const [variant, setVariantState] = useState<BasemapVariant>("scheme");
  const [satConsent, setSatConsent] = useState(false);
  const [askConsent, setAskConsent] = useState(false);
  const [satFailed, setSatFailed] = useState(false);
  const setVariant = useCallback(
    (v: BasemapVariant) => {
      if (v === "hybrid" && !satConsent) {
        setAskConsent(true);
        return;
      }
      if (v === "hybrid") setSatFailed(false);
      setVariantState(v);
    },
    [satConsent],
  );
  const acceptSatellite = useCallback(() => {
    setSatConsent(true);
    setAskConsent(false);
    setSatFailed(false);
    setVariantState("hybrid");
  }, []);
  const declineSatellite = useCallback(() => setAskConsent(false), []);
  const [coverageFitSignal, setCoverageFitSignal] = useState(0);
  const rec = useRecommend();
  const [form, setFormState] = useState<WalkForm>(initialForm);
  const setForm = useCallback((u: (f: WalkForm) => WalkForm) => setFormState(u), []);
  const [pickRequested, setPickRequested] = useState(false);
  const [originWarning, setOriginWarning] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The timebox plan and a single place are mutually exclusive selections on the map.
  const [planShown, setPlanShown] = useState(false);
  const [removal, setRemoval] = useState<PlanRemoval | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const [fitSignal, setFitSignal] = useState(0);
  const [centerRequest, setCenterRequest] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("3d");
  const [editing, setEditing] = useState(false);
  const [sheet, setSheet] = useState<Sheet>("half");
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const panelScrollRef = useRef<HTMLDivElement>(null);
  const { state } = rec;
  const response = state.response;
  // While the model is still writing explanations, the places already found are shown (and marked).
  const pending = state.status === "loading" && !!state.preliminary;
  const shown = state.status === "loading" ? state.preliminary : response;
  const recs = useMemo(() => shown?.recommendations ?? [], [shown]);
  const pickActive = pickRequested || !form.origin;
  const routeRequest = pending ? state.request : state.responseRequest;
  const routeOriginMatches = !!form.origin && !!routeRequest &&
    form.origin.lat === routeRequest.origin.lat && form.origin.lon === routeRequest.origin.lon;
  const plan = shown?.plan ?? null;
  const selectedRoute = !routeOriginMatches || pickActive ? null
    : planShown && plan ? mapRouteOfPlan(plan)
    : mapRouteOf(recs.find((r) => r.place_id === selectedId)?.route ?? null);
  // Equivalent final explanations must not restart the route/camera animation.
  const routeKey = JSON.stringify(selectedRoute);
  const activeRoute = useMemo(() => selectedRoute, [routeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const coverageFc: FeatureCollection | undefined = useMemo(() => {
    if (map.layers.coverage?.data.features.length) return map.layers.coverage.data;
    if (coverage.data?.features.length) return { type: "FeatureCollection", features: coverage.data.features } as unknown as FeatureCollection;
    return undefined;
  }, [map.layers.coverage, coverage.data]);
  const heights = useMemo(() => heightStats(map.layers.buildings?.data), [map.layers.buildings]);
  const providerLines = useMemo(() => describeProviders(ready.data, response?.providers), [ready.data, response]);
  // Preserve a choice made while explanations load, if it survives the final answer.
  const resultSet = JSON.stringify(recs.map((r) => r.place_id).sort());
  const answerId = shown?.client_request_id;
  const firstRoutedId = recs.find((r) => r.route)?.place_id ?? null;
  const hasPlan = !!plan;
  const shownSelectedId = planShown && plan ? null : selectedId;
  // Only the answer to that very "Убрать" request gets the change note.
  const planChange = removal && shown?.client_request_id === removal.requestId ? describeRemoval(removal, plan) : null;
  useEffect(() => {
    const ids: string[] = JSON.parse(resultSet);
    setSelectedId((current) => current && ids.includes(current) ? current : firstRoutedId);
    if (ids.length) setFitSignal((n) => n + 1);
  }, [answerId, resultSet, firstRoutedId]);
  // A new answer with a plan opens on the plan; one without a plan opens on its first place.
  useEffect(() => setPlanShown(hasPlan), [answerId, hasPlan]);
  const setOrigin = useCallback(
    (o: Origin) => {
      const inside = pointInCoverage(o.lon, o.lat, coverageFc);
      if (inside === false) {
        setOriginWarning(o.kind === "gps" ? `Ваше местоположение вне зоны рекомендаций. ${OUTSIDE_DETAIL}` : OUTSIDE_MSG);
        return;
      }
      setOriginWarning(null);
      setPickRequested(false);
      setForm((f) => ({ ...f, origin: o }));
      if (o.kind !== "map") setFitSignal((n) => n + 1);
    },
    [coverageFc, setForm],
  );
  const onMapPick = useCallback(
    (lon: number, lat: number) => setOrigin({ lon, lat, kind: "map", label: "Точка на карте" }),
    [setOrigin],
  );
  const onCenter = useCallback(
    (lon: number, lat: number) => setOrigin({ lon, lat, kind: "center", label: "Центр карты" }),
    [setOrigin],
  );
  const send = useCallback(
    (f: WalkForm, userTurn: string) => {
      if (!f.origin) return;
      const request = buildRequest(f, newClientRequestId(), state.context);
      setEditing(false);
      setSelectedId(null);
      setSheet((s) => (s === "collapsed" ? "half" : s));
      rec.submit(request, userTurn);
      panelScrollRef.current?.scrollTo({ top: 0 });
    },
    [rec, state.context],
  );
  const onSubmit = () => {
    const turn =
      form.query.trim() ||
      [`Прогулка ${form.timeBudget} мин`, ...form.interests.map((i) => INTEREST_LABEL[i])].join(", ");
    send(form, turn);
  };
  const onRefine = (kind: RefinementKind) => {
    const base = state.responseRequest?.constraints ?? form.constraints;
    const next = { ...form, constraints: refineConstraints(kind, base, recs) };
    setFormState(next);
    send(next, REFINEMENT_LABEL[kind]);
  };
  const onRelax = (r: Relaxation) => {
    const next = { ...form, constraints: r.patch };
    setFormState(next);
    send(next, r.message);
  };
  const onRemoveStop = (placeId: string) => {
    // The request that produced this plan, with one more excluded place; everything else is kept.
    // Also while explanations load: the in-flight request is aborted and replaced.
    if (!routeRequest || !routeOriginMatches) return;
    const constraints = withoutStop(routeRequest.constraints, placeId);
    const requestId = newClientRequestId();
    const stop = plan?.stops.find((s) => s.place_id === placeId);
    setRemoval({ requestId, removedName: stop?.name ?? "места", previousIds: plan?.stops.map((s) => s.place_id) ?? [] });
    setFormState((f) => ({ ...f, constraints }));
    setEditing(false);
    setSelectedId(null);
    rec.submit(
      { ...routeRequest, constraints, conversation_context: state.context.slice(-6), client_request_id: requestId },
      "Убрать остановку из плана",
    );
    panelScrollRef.current?.scrollTo({ top: 0 });
  };
  const showPlan = useCallback(() => {
    setPlanShown(true);
    setFocusSignal((n) => n + 1);
  }, []);
  const onRetry = () => {
    if (state.request) rec.submit(state.request, state.pendingUserTurn ?? ""); // same client_request_id: no duplicate
  };
  const onReset = () => {
    rec.reset();
    setFormState(initialForm);
    setSelectedId(null);
    setOriginWarning(null);
    setPickRequested(false);
    setEditing(false);
    cardRefs.current.clear();
  };
  const selectFromCard = useCallback((id: string) => {
    setPlanShown(false);
    setSelectedId(id);
    setFocusSignal((n) => n + 1);
  }, []);
  const selectFromMap = useCallback(
    (id: string) => {
      setPlanShown(false);
      setSelectedId(id);
      if (!isDesktop) setSheet((s) => (s === "collapsed" ? "half" : s));
      // Centre the chosen place so it is never left under the panel, legend or controls; on mobile
      // after the sheet has resized the map (the camera keeps the centre on resize).
      if (isDesktop) setFocusSignal((n) => n + 1);
      else window.setTimeout(() => setFocusSignal((n) => n + 1), 80);
      requestAnimationFrame(() => {
        const el = cardRefs.current.get(id);
        const box = panelScrollRef.current;
        if (!el || !box) return;
        // Scroll only the panel (scrollIntoView would also scroll the clipped page shell).
        const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12;
        box.scrollTo({ top, behavior: reducedMotion ? "auto" : "smooth" });
        el.focus({ preventScroll: true });
      });
    },
    [isDesktop, reducedMotion],
  );
  const startPick = () => {
    setPickRequested((v) => !v || !form.origin);
    if (!isDesktop) setSheet("collapsed");
  };
  const blockedReason = !online ? "Нет подключения к интернету." : state.status === "loading" ? "Идёт подбор…" : null;
  const showResults = !!response && !editing && state.status !== "loading";
  // ---------------------------------------------------------------- panel content
  let panel: React.ReactNode;
  if (state.status === "loading" && pending && state.preliminary) {
    panel = (
      <div className="space-y-4">
        <ProgressPanel startedAt={state.startedAt} onCancel={rec.cancel} compact />
        <ResultsPanel
          key="results"
          response={state.preliminary}
          constraints={state.request?.constraints ?? form.constraints}
          budget={state.request?.time_budget_min ?? null}
          startTime={state.request?.start_time ?? null}
          selectedId={shownSelectedId}
          cardRefs={cardRefs}
          busy
          pending
          cancelled={false}
          onSelect={selectFromCard}
          planShown={planShown}
        planStale={!routeOriginMatches}
          planChange={planChange}
          onShowPlan={showPlan}
          onRemoveStop={onRemoveStop}
          onRefine={onRefine}
          onRelax={onRelax}
          onEdit={() => setEditing(true)}
          onReset={onReset}
        />
      </div>
    );
  } else if (state.status === "loading") {
    panel = <ProgressPanel startedAt={state.startedAt} onCancel={rec.cancel} />;
  } else if (state.status === "error" && state.error && !editing) {
    panel = (
      <div className="space-y-4">
        <ErrorCard error={state.error} online={online} onRetry={onRetry} onEdit={() => setEditing(true)} />
        {response && (
          <p className="text-sm text-muted">Предыдущий результат сохранён — нажмите «Изменить запрос», чтобы вернуться к форме.</p>
        )}
      </div>
    );
  } else if (showResults && response) {
    panel = (
      <div className="space-y-4">
      <ResultsPanel
        key="results"
        response={response}
        note={state.partialNote}
        constraints={state.responseRequest?.constraints ?? form.constraints}
        budget={state.responseRequest?.time_budget_min ?? null}
        startTime={state.responseRequest?.start_time ?? null}
        selectedId={shownSelectedId}
        cardRefs={cardRefs}
        busy={false}
        cancelled={state.cancelled}
        onSelect={selectFromCard}
        planShown={planShown}
        planStale={!routeOriginMatches}
          planChange={planChange}
        onShowPlan={showPlan}
        onRemoveStop={onRemoveStop}
        onRefine={onRefine}
        onRelax={onRelax}
        onEdit={() => setEditing(true)}
        onReset={onReset}
      />
      </div>
    );
  } else {
    panel = (
      <div className="space-y-4">
        {state.cancelled && !response && (
          <p role="status" className="rounded-control bg-paper p-2 text-sm text-muted">
            Запрос отменён.
          </p>
        )}
        {editing && response && (
          <button type="button" className="sc-btn w-full" onClick={() => setEditing(false)}>
            ← Вернуться к результатам
          </button>
        )}
        <WalkFormPanel
          form={form}
          setForm={setForm}
          coverage={coverage.data}
          pickActive={pickActive}
          originWarning={originWarning}
          onSetOrigin={setOrigin}
          onStartPick={startPick}
          onSubmit={onSubmit}
          blockedReason={blockedReason}
          externalProvider={hasExternalProvider(providerLines)}
        />
        {(response || form !== initialForm) && (
          <button type="button" className="sc-btn w-full" onClick={onReset}>
            Начать заново
          </button>
        )}
      </div>
    );
  }
  const sheetHeight = sheet === "collapsed" ? "calc(140px + var(--safe-bottom))" : sheet === "half" ? "52%" : "100%";
  const mapBottom = sheet === "collapsed" ? "calc(140px + var(--safe-bottom))" : "52%";
  const allLayersFailed = map.failed.length > 0 && Object.keys(map.layers).length === 0;
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <a href="#panel" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-2">
        Перейти к панели подбора
      </a>
      <Header
        coverage={coverage.data}
        coverageError={coverage.isError}
        ready={ready.data}
        basemap={basemap.data}
        providerLines={providerLines}
      />
      <StatusBanners online={online} ready={ready.data} readyError={ready.isError} onRetryReady={() => void ready.refetch()} />
      <main className="relative min-h-0 flex-1 lg:flex">
        {/* ---------------- panel (desktop: left column; mobile: bottom sheet) */}
        <aside
          id="panel"
          aria-label="Подбор прогулки"
          className="z-20 flex flex-col border-stroke bg-paper max-lg:absolute max-lg:inset-x-0 max-lg:bottom-0 max-lg:rounded-t-[20px] max-lg:border-t max-lg:shadow-panel lg:relative lg:w-[392px] lg:shrink-0 lg:border-r"
          style={isDesktop ? undefined : { height: sheetHeight }}
          data-sheet={sheet}
        >
          <div className="flex items-center gap-2 px-4 pb-1 pt-2 lg:hidden">
            <button
              type="button"
              className="grid h-11 w-14 place-items-center"
              aria-label={sheet === "full" ? "Свернуть панель" : "Развернуть панель"}
              onClick={() => setSheet((s) => (s === "collapsed" ? "half" : s === "half" ? "full" : "collapsed"))}
            >
              <span aria-hidden className="h-1.5 w-10 rounded-full bg-[#B9C2B6]" />
            </button>
            <div className="ml-auto flex rounded-control bg-[#ECEFE7] p-1" role="group" aria-label="Вид">
              <button
                type="button"
                aria-pressed={sheet !== "full"}
                className="min-h-[44px] rounded-[10px] px-4 text-sm font-semibold aria-pressed:bg-graphite aria-pressed:text-white"
                onClick={() => {
                  setSheet("collapsed");
                  // The map grows when the sheet collapses: re-fit the results once the layout has settled.
                  if (recs.length) window.setTimeout(() => setFitSignal((n) => n + 1), 80);
                }}
              >
                Карта
              </button>
              <button
                type="button"
                aria-pressed={sheet === "full"}
                className="min-h-[44px] rounded-[10px] px-4 text-sm font-semibold aria-pressed:bg-graphite aria-pressed:text-white"
                onClick={() => setSheet("full")}
              >
                Список
              </button>
            </div>
          </div>
          <div ref={panelScrollRef} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[calc(16px+var(--safe-bottom))] pt-2 lg:p-5">
            {panel}
            <p className="mt-6 text-xs text-muted lg:hidden">
              Карта:{" "}
              <a className="underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
                © OpenStreetMap contributors
              </a>
            </p>
          </div>
        </aside>
        {/* ---------------- map */}
        <section
          aria-label="Карта"
          className="isolate max-lg:absolute max-lg:inset-x-0 max-lg:top-0 lg:relative lg:min-w-0 lg:flex-1"
          style={isDesktop ? undefined : { bottom: mapBottom }}
        >
          {basemap.isPending && !mapFatal ? (
            // Wait for /api/basemap (a few ms): tile URLs carry its archive version, and the satellite
            // source depends on the licence mode — creating the map earlier would load tiles twice.
            <div className="absolute inset-0 grid place-items-center" role="status">
              <p className="rounded-control bg-white/90 px-4 py-2 text-sm font-semibold shadow-control">Загружаем карту…</p>
            </div>
          ) : mapFatal ? (
            <FallbackMap
              layers={map.layers}
              origin={form.origin}
              recs={recs}
              selectedId={shownSelectedId}
              pickActive={pickActive}
              reason={mapFatal}
              onPick={onMapPick}
              onSelectPlace={selectFromMap}
            />
          ) : (
            <MapView
              route={activeRoute}
              coverage={coverageFc}
              boundary={boundary.data}
              coverageFitSignal={coverageFitSignal}
              variant={variant}
              satellite={satellite}
              tilesVersion={basemap.data?.tiles_version ?? null}
              onVariantChange={setVariant}
              onSatelliteError={() => setSatFailed(true)}
              origin={form.origin}
              recs={selectedRoute?.kind === "plan" ? [] : recs}
              selectedId={shownSelectedId}
              focusSignal={focusSignal}
              fitSignal={fitSignal}
              pickActive={pickActive}
              reducedMotion={reducedMotion}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              onPick={onMapPick}
              onSelectPlace={selectFromMap}
              onFatal={setMapFatal}
              centerRequest={centerRequest}
              onCenter={onCenter}
            />
          )}
          <div className="pointer-events-none absolute left-3 right-16 top-3 z-10 flex flex-col items-start gap-2">
            {pickActive && !mapFatal && (
              <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-control bg-graphite px-3 py-2 text-sm text-white shadow-control" role="status">
                <span className="text-[13px] sm:text-sm">Нажмите на карту, чтобы выбрать точку старта</span>
                <button type="button" className="min-h-[44px] rounded-[10px] bg-white px-3 font-semibold text-graphite" onClick={() => setCenterRequest((n) => n + 1)}>
                  Центр карты
                </button>
                {form.origin && (
                  <button type="button" className="min-h-[44px] rounded-[10px] border border-white/40 px-3 font-semibold" onClick={() => setPickRequested(false)}>
                    Отмена
                  </button>
                )}
              </div>
            )}
            {pickActive && mapFatal && (
              <p className="pointer-events-auto mt-12 rounded-control bg-graphite px-3 py-2 text-sm text-white" role="status">
                Нажмите на карту, чтобы выбрать точку старта
              </p>
            )}
            {originWarning && (
              <div role="alert" className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-control bg-warn-bg px-3 py-1.5 text-sm font-semibold text-warn-fg shadow-control">
                <span>Вне зоны рекомендаций</span>
                {!mapFatal && coverageFc && (
                  <button type="button" className="min-h-[44px] rounded-[10px] px-2 underline" onClick={() => setCoverageFitSignal((n) => n + 1)}>
                    Показать зону
                  </button>
                )}
              </div>
            )}
            {map.failed.length > 0 && (
              <div role="alert" className="pointer-events-auto rounded-control bg-danger-bg px-3 py-2 text-sm text-danger-fg shadow-control">
                {allLayersFailed ? "Не удалось загрузить данные карты." : `Не загрузились слои карты: ${map.failed.join(", ")}.`}{" "}
                <button type="button" className="ml-1 min-h-[44px] font-semibold underline" onClick={map.refetch}>
                  Повторить
                </button>
              </div>
            )}
            {satFailed && variant === "hybrid" && !mapFatal && (
              <div role="status" className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-control bg-warn-bg px-3 py-1.5 text-sm text-warn-fg shadow-control">
                <span>Спутниковые снимки не загрузились — схема и здания работают.</span>
                <button type="button" className="min-h-[44px] font-semibold underline" onClick={() => setVariantState("scheme")}>
                  Только схема
                </button>
              </div>
            )}
            {basemap.isError && !mapFatal && (
              <div role="alert" className="pointer-events-auto rounded-control bg-danger-bg px-3 py-2 text-sm text-danger-fg shadow-control">
                Базовая карта города недоступна (тайлы не собраны или API не отвечает).{" "}
                <button type="button" className="ml-1 min-h-[44px] font-semibold underline" onClick={() => void basemap.refetch()}>
                  Повторить
                </button>
              </div>
            )}
            {map.dropped > 0 && (
              <p role="status" className="pointer-events-auto rounded-control bg-white/95 px-3 py-1.5 text-xs shadow-control">
                Неполные данные: {map.dropped} объектов карты пропущено из-за неверной геометрии.
              </p>
            )}
          </div>
          {activeRoute && mapFatal && (
            <p role="status" className="absolute bottom-10 left-3 right-3 rounded-control bg-white p-2 text-xs">
              Пеший путь рассчитан, но простая карта не отображает его линию. Длительность и ограничения — в карточке.
            </p>
          )}
          {askConsent && !mapFatal && <SatelliteConsent onAccept={acceptSatellite} onDecline={declineSatellite} />}
          {!mapFatal && (
            // Mobile: top-left so the collapsed legend never covers the start marker near the sheet.
            <div className="absolute left-2 top-2 z-10 lg:bottom-9 lg:top-auto">
              <HeightLegend
                stats={basemap.data?.height_source ?? heights}
                levelHeight={basemap.data?.level_height_m ?? 3.2}
                defaultHeight={basemap.data?.default_height_m ?? 10}
                cityWide={!!basemap.data}
                stylised={(basemap.data?.stylised_landmarks?.length ?? 0) > 0}
                defaultOpen={false}
              />
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
