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
import { useCoverage, useMapLayers, useMediaQuery, useOnline, useReady, useRecommend, useReducedMotion } from "@/lib/hooks";
import { INTEREST_LABEL } from "@/lib/labels";
import { heightStats, pointInCoverage } from "@/lib/mapData";
import type { ViewMode } from "@/lib/mapStyle";
import { newClientRequestId } from "@/lib/recommendState";
import { ErrorCard } from "./ErrorCard";
import { Header } from "./Header";
import { FallbackMap } from "./map/FallbackMap";
import { HeightLegend } from "./map/HeightLegend";
import { MapView } from "./map/MapView";
import { ProgressPanel } from "./ProgressPanel";
import { ResultsPanel } from "./ResultsPanel";
import { StatusBanners } from "./StatusBanners";
import { WalkFormPanel } from "./WalkFormPanel";

type Sheet = "collapsed" | "half" | "full";

const OUTSIDE_MSG =
  "Вне зоны покрытия данных. Сейчас собраны места только в районе EXPO / MEGA Silk Way (пунктирная граница на карте). Выберите точку внутри неё или демо-точку.";

export function App() {
  const online = useOnline();
  const reducedMotion = useReducedMotion();
  const isDesktop = useMediaQuery("(min-width: 1024px)", true);
  const ready = useReady();
  const coverage = useCoverage();
  const map = useMapLayers();
  const rec = useRecommend();

  const [form, setFormState] = useState<WalkForm>(initialForm);
  const setForm = useCallback((u: (f: WalkForm) => WalkForm) => setFormState(u), []);
  const [pickRequested, setPickRequested] = useState(false);
  const [originWarning, setOriginWarning] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const [fitSignal, setFitSignal] = useState(0);
  const [centerRequest, setCenterRequest] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("3d");
  const [mapFatal, setMapFatal] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [sheet, setSheet] = useState<Sheet>("half");
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const panelScrollRef = useRef<HTMLDivElement>(null);

  const { state } = rec;
  const response = state.response;
  const recs = useMemo(() => response?.recommendations ?? [], [response]);
  const pickActive = pickRequested || !form.origin;

  const coverageFc: FeatureCollection | undefined = useMemo(() => {
    if (map.layers.coverage?.data.features.length) return map.layers.coverage.data;
    if (coverage.data?.features.length) return { type: "FeatureCollection", features: coverage.data.features } as unknown as FeatureCollection;
    return undefined;
  }, [map.layers.coverage, coverage.data]);

  const heights = useMemo(() => heightStats(map.layers.buildings?.data), [map.layers.buildings]);

  // New answer → clear selection and fit camera to origin + results.
  useEffect(() => {
    if (!response) return;
    setSelectedId(null);
    if (response.recommendations.length) setFitSignal((n) => n + 1);
  }, [response]);

  const setOrigin = useCallback(
    (o: Origin) => {
      const inside = pointInCoverage(o.lon, o.lat, coverageFc);
      if (inside === false) {
        setOriginWarning(o.kind === "gps" ? `Ваше местоположение вне зоны покрытия. ${OUTSIDE_MSG}` : OUTSIDE_MSG);
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
    setSelectedId(id);
    setFocusSignal((n) => n + 1);
  }, []);

  const selectFromMap = useCallback(
    (id: string) => {
      setSelectedId(id);
      if (!isDesktop) setSheet((s) => (s === "collapsed" ? "half" : s));
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
  if (state.status === "loading") {
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
      <ResultsPanel
        response={response}
        constraints={state.responseRequest?.constraints ?? form.constraints}
        budget={state.responseRequest?.time_budget_min ?? null}
        selectedId={selectedId}
        cardRefs={cardRefs}
        busy={false}
        cancelled={state.cancelled}
        onSelect={selectFromCard}
        onRefine={onRefine}
        onRelax={onRelax}
        onEdit={() => setEditing(true)}
        onReset={onReset}
      />
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
  const allLayersFailed = map.failed.length === 5;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <a href="#panel" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-2">
        Перейти к панели подбора
      </a>
      <Header
        coverage={coverage.data}
        coverageError={coverage.isError}
        ready={ready.data}
        heights={heights}
        buildingsLoaded={!!map.layers.buildings}
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
                onClick={() => setSheet("collapsed")}
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
          className="max-lg:absolute max-lg:inset-x-0 max-lg:top-0 lg:relative lg:min-w-0 lg:flex-1"
          style={isDesktop ? undefined : { bottom: mapBottom }}
        >
          {mapFatal ? (
            <FallbackMap
              layers={map.layers}
              origin={form.origin}
              recs={recs}
              selectedId={selectedId}
              pickActive={pickActive}
              reason={mapFatal}
              onPick={onMapPick}
              onSelectPlace={selectFromMap}
            />
          ) : (
            <MapView
              layers={map.layers}
              origin={form.origin}
              recs={recs}
              selectedId={selectedId}
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
              <p role="alert" className="pointer-events-auto rounded-control bg-warn-bg px-3 py-2 text-sm font-semibold text-warn-fg shadow-control">
                Вне зоны покрытия данных
              </p>
            )}
            {map.failed.length > 0 && (
              <div role="alert" className="pointer-events-auto rounded-control bg-danger-bg px-3 py-2 text-sm text-danger-fg shadow-control">
                {allLayersFailed ? "Не удалось загрузить данные карты." : `Не загрузились слои карты: ${map.failed.join(", ")}.`}{" "}
                <button type="button" className="ml-1 min-h-[44px] font-semibold underline" onClick={map.refetch}>
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

          {!mapFatal && (
            <div className="absolute bottom-9 left-2 z-10">
              <HeightLegend stats={heights} defaultOpen={isDesktop} />
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
