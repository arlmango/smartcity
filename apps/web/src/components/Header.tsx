"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { BasemapInfo, CoverageResponse, ReadyResponse } from "@/lib/contracts";
import { formatDate, formatDateTime } from "@/lib/format";
import type { ProviderLine } from "@/lib/providers";

interface Props {
  coverage: CoverageResponse | undefined;
  coverageError: boolean;
  ready: ReadyResponse | undefined;
  basemap: BasemapInfo | undefined;
  providerLines: ProviderLine[];
}

const COMPONENT_LABEL: Record<string, string> = {
  db: "База данных",
  data: "Данные мест",
  map: "Слои карты района",
  basemap: "Базовая карта города",
  embeddings: "Поиск по смыслу (embeddings)",
  llm: "Языковая модель",
  routing: "Пешеходный маршрутизатор",
};
const STATUS_LABEL: Record<string, string> = {
  ok: "работает",
  degraded: "с ограничениями",
  unavailable: "недоступно",
  not_configured: "не подключено",
};

/** Estimate rules exactly as the API reports them (e.g. "garage, shed… 3 м"), not hard-coded here. */
function estimateText(b: BasemapInfo | undefined): string {
  const parts = Object.values(b?.estimate_rules ?? {}).flatMap((rules) =>
    Object.entries(rules).map(([k, m]) => `${k} — ${m.toLocaleString("ru-RU")} м`),
  );
  return parts.length ? ` (${parts.join("; ")})` : "";
}

export function Header({ coverage, coverageError, ready, basemap, providerLines }: Props) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const areaName =
    (coverage?.features[0]?.properties as { name?: unknown } | undefined)?.name ?? "Район EXPO / MEGA Silk Way";
  const hs = basemap?.height_source;
  const km2 = basemap?.coverage?.boundary_area_km2;
  const sat = basemap?.satellite;

  return (
    <header className="relative z-30 flex h-14 shrink-0 items-center gap-3 border-b border-stroke bg-paper px-3 pt-[var(--safe-top)] sm:px-5">
      <div className="flex items-center gap-2">
        <span aria-hidden className="grid h-8 w-8 place-items-center rounded-[10px] bg-graphite text-lime">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z" />
          </svg>
        </span>
        <span className="text-lg font-extrabold tracking-tight">SmartCity</span>
      </div>
      <span className="rounded-full border border-stroke bg-white px-2.5 py-1 text-sm font-semibold">Астана</span>
      <p className="hidden min-w-0 flex-1 truncate text-sm text-muted md:block">
        Короткая прогулка от выбранной точки: 1–3 реальных места из открытых данных
      </p>
      <div className="ml-auto">
        <button
          ref={btnRef}
          type="button"
          className="sc-btn"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        >
          <span aria-hidden>ⓘ</span> О данных
        </button>
      </div>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="О данных"
          className="absolute right-3 top-[calc(100%+6px)] z-40 w-[min(92vw,380px)] rounded-panel border border-stroke bg-white p-4 text-sm shadow-panel"
        >
          <h2 className="mb-2 text-base font-bold">О данных</h2>
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5">
            <dt className="text-muted">Карта</dt>
            <dd data-testid="map-coverage">
              {basemap?.coverage?.boundary_inside_tiles
                ? `Вся Астана в административных границах OSM${km2 ? ` (${Math.round(km2)} км²)` : ""}`
                : basemap
                  ? "Прямоугольник вокруг Астаны (граница города не проверена)"
                  : "загрузка…"}
            </dd>
            <dt className="text-muted">База мест</dt>
            <dd>{String(areaName)} — только здесь подбираются прогулки</dd>
            <dt className="text-muted">Мест в базе</dt>
            <dd>{coverage ? coverage.place_count : coverageError ? "нет данных (API недоступен)" : "загрузка…"}</dd>
            <dt className="text-muted">Снимок OSM</dt>
            <dd>{coverage ? formatDate(coverage.freshness) : "—"}</dd>
            <dt className="text-muted">Обновлено</dt>
            <dd>{coverage ? formatDateTime(coverage.updated_at) : "—"}</dd>
            <dt className="text-muted">Версия</dt>
            <dd className="break-all">{coverage?.dataset_version ?? "—"}</dd>
            <dt className="text-muted">Источник</dt>
            <dd>
              <a
                className="underline"
                href="https://www.openstreetmap.org/copyright"
                target="_blank"
                rel="noopener noreferrer"
              >
                © OpenStreetMap contributors
              </a>
              , лицензия ODbL&nbsp;1.0
            </dd>
          </dl>
          <p className="mt-3 rounded-control bg-paper p-2.5 text-[13px] leading-snug">
            <strong>Высоты зданий приблизительные.</strong>{" "}
            {hs
              ? `Из ${hs.height + hs.levels + hs.estimate + hs.default} контуров: ${hs.height} — высота из OSM, ${hs.levels} — по этажности (×3,2 м), ${hs.estimate} — оценка по типу здания или площади${estimateText(basemap)}, ${hs.default} — условно 10 м.`
              : "Высота берётся из OSM, иначе по этажности (×3,2 м), иначе оценка по типу/площади, иначе условно 10 м."}{" "}
            Крыши — приближение по тегу roof:shape; фасадов и текстур нет.
          </p>
          <p className="mt-2 text-[13px] leading-snug">
            <strong>Подложка.</strong> Векторные тайлы Protomaps (© OpenStreetMap contributors, ODbL).{" "}
            {sat?.enabled
              ? "Режим «Гибрид»: на обзоре города — спутниковые снимки EOxCloudless 2024 (10 м/пиксель, CC BY-NC-SA 4.0, только некоммерческое использование); тайлы загружаются браузером с tiles.maps.eox.at."
              : sat
                ? "Спутниковый слой отключён (коммерческий режим или настройка)."
                : ""}
          </p>
          <p className="mt-2 text-[13px] leading-snug text-muted">
            Расстояния считаются по прямой, время — приблизительно. Часы работы из OSM могут быть устаревшими. Данные не
            обновляются в реальном времени.
          </p>
          {providerLines.length > 0 && (
            <div className="mt-3" data-testid="provider-disclosure">
              <h3 className="sc-label mb-1">Кто обрабатывает запрос</h3>
              <ul className="space-y-1 text-[13px] leading-snug">
                {providerLines.map((l) => (
                  <li key={l.role} className={l.external ? "rounded-control bg-warn-bg p-2 font-semibold text-warn-fg" : ""}>
                    {l.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ready && (
            <div className="mt-3">
              <h3 className="sc-label mb-1">Состояние сервиса</h3>
              <ul className="space-y-0.5 text-[13px]">
                {Object.entries(ready.components).map(([k, v]) => (
                  <li key={k}>
                    {COMPONENT_LABEL[k] ?? k}: <span className="font-semibold">{STATUS_LABEL[v.status] ?? v.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
