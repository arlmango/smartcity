"use client";

import { forwardRef } from "react";
import type { Recommendation } from "@/lib/contracts";
import {
  formatDate,
  formatDistanceWithMethod,
  hostOf,
  openingLabel,
  safeHttpUrl,
  timingRows,
  timingTotalLabel,
} from "@/lib/format";
import { CATEGORY_META, FEATURE_LABEL, FEATURE_NEGATIVE, FEATURE_UNKNOWN } from "@/lib/labels";

interface Props {
  rec: Recommendation;
  index: number;
  selected: boolean;
  budget: number | null;
  retrievalOnly: boolean;
  /** The model is still writing explanations for this (preliminary) answer. */
  pending?: boolean;
  onSelect: (placeId: string) => void;
}

export function displayName(rec: Pick<Recommendation, "name" | "name_is_generic" | "category_label">): string {
  return rec.name_is_generic ? `${rec.category_label} · без названия в OSM` : rec.name;
}

const OPENING_STYLE = {
  open: "bg-ok-bg text-ok-fg",
  closed: "bg-danger-bg text-danger-fg",
  unknown: "bg-warn-bg text-warn-fg",
} as const;

export const RecommendationCard = forwardRef<HTMLElement, Props>(function RecommendationCard(
  { rec, index, selected, budget, retrievalOnly, pending = false, onSelect },
  ref,
) {
  const n = index + 1;
  const osmUrl = safeHttpUrl(rec.source.url);
  const website = safeHttpUrl(rec.website);
  const cat = CATEGORY_META[rec.category];
  const name = displayName(rec);
  const titleId = `card-title-${n}`;

  return (
    <article
      ref={ref}
      data-place-id={rec.place_id}
      data-testid="rec-card"
      aria-labelledby={titleId}
      aria-current={selected ? "true" : undefined}
      tabIndex={-1}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a,button,summary")) return;
        onSelect(rec.place_id);
      }}
      className={`sc-card scroll-mt-4 p-4 transition-shadow ${selected ? "border-graphite shadow-panel ring-2 ring-graphite" : ""}`}
    >
      <header className="flex items-start gap-3">
        <span
          aria-hidden
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border-2 text-sm font-extrabold ${
            selected ? "border-graphite bg-lime text-graphite" : "border-graphite bg-graphite text-white"
          }`}
        >
          {n}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-wider text-muted">
            <span aria-hidden>{cat.icon}</span> {rec.category_label || cat.label}
          </p>
          <h3 id={titleId} className="break-words text-lg font-bold leading-snug">
            <span className="sr-only">Вариант {n}: </span>
            {name}
          </h3>
          {rec.address && <p className="text-sm text-muted">{rec.address}</p>}
        </div>
      </header>

      <button
        type="button"
        className="sc-btn mt-3 w-full"
        aria-pressed={selected}
        onClick={() => onSelect(rec.place_id)}
      >
        <span aria-hidden>⌖</span> {selected ? "Показано на карте" : "Показать на карте"}
      </button>

      {/* ---- AI / estimates */}
      <div className="mt-3 space-y-2">
        <div className="rounded-control border border-dashed border-[#C5CCB8] bg-[#FAFBF6] p-3">
          <p className="mb-1 flex items-center gap-2 text-xs font-bold text-muted">
            Почему подходит{" "}
            <span className="sc-tag-ai">{rec.reason_source === "llm" ? "ИИ" : "по правилам"}</span>
          </p>
          {rec.reason ? (
            <p className="text-sm leading-relaxed">{rec.reason}</p>
          ) : (
            <p className="text-sm text-muted">
              {pending
                ? "Объяснение ИИ готовится…"
                : retrievalOnly
                ? "Объяснение ИИ недоступно — место найдено поиском по базе."
                : rec.reason_source === "llm"
                  ? "Объяснение ИИ не прошло проверку фактов и скрыто."
                  : "Объяснения нет."}
            </p>
          )}
        </div>
        {rec.activity_suggestion && (
          <div className="rounded-control border border-dashed border-[#C5CCB8] bg-[#FAFBF6] p-3">
            <p className="mb-1 flex items-center gap-2 text-xs font-bold text-muted">
              Идея <span className="sc-tag-ai">оценка</span>
            </p>
            <p className="text-sm leading-relaxed">{rec.activity_suggestion}</p>
          </div>
        )}
      </div>

      {/* ---- distance & timing (estimates) */}
      <div className="mt-3 rounded-control bg-paper p-3 text-sm">
        <p className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span className="font-semibold">{formatDistanceWithMethod(rec.distance.meters, rec.distance.method)}</span>
          <span className="text-xs text-muted">Время приблизительное</span>
        </p>
        {rec.distance.note && <p className="text-xs text-muted">{rec.distance.note}</p>}
        <table className="mt-2 w-full text-sm">
          <caption className="sr-only">Бюджет времени (оценка)</caption>
          <tbody>
            {timingRows(rec.timing).map((r) => (
              <tr key={r.key}>
                <th scope="row" className="py-0.5 text-left font-normal text-muted">
                  {r.label}
                </th>
                <td className="py-0.5 text-right tabular-nums">≈ {r.minutes} мин</td>
              </tr>
            ))}
            {rec.timing.return_min === null && (
              <tr>
                <th scope="row" className="py-0.5 text-left font-normal text-muted">
                  Обратно
                </th>
                <td className="py-0.5 text-right text-muted">не учитывается</td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t border-stroke">
              <td colSpan={2} className="pt-1.5 text-right font-bold" data-testid="timing-total">
                {timingTotalLabel(rec.timing, budget)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ---- facts */}
      <div className="mt-3 space-y-2 text-sm">
        <div>
          <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${OPENING_STYLE[rec.opening_status]}`}>
            {openingLabel(rec.opening_status, rec.opening_hours_raw)}
          </span>
          <p className="mt-1 text-xs text-muted">
            {rec.opening_note}
            {rec.opening_hours_raw && (
              <>
                {" "}
                · часы в OSM: <code className="break-words rounded bg-paper px-1">{rec.opening_hours_raw}</code>
              </>
            )}
          </p>
        </div>

        {rec.verified_features.length > 0 && (
          <div>
            <p className="mb-1 flex items-center gap-2 text-xs font-bold text-muted">
              Подтверждено <span className="sc-tag-fact">факт · OSM</span>
            </p>
            <ul className="space-y-1">
              {rec.verified_features.map((f) => (
                <li key={f.feature}>
                  <details>
                    <summary className="flex min-h-[44px] cursor-pointer items-center gap-1.5">
                      <span aria-hidden className="text-ok-fg">
                        ✓
                      </span>
                      {FEATURE_LABEL[f.feature]}
                      <span className="text-xs text-muted">(источник)</span>
                    </summary>
                    <p className="ml-5 text-xs text-muted">
                      {f.basis === "category_rule" ? "Правило категории: " : ""}
                      {f.evidence}
                    </p>
                  </details>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(rec.unknown_features.length > 0 || rec.negative_features.length > 0) && (
          <ul className="space-y-1" aria-label="Не подтверждено или отсутствует">
            {rec.unknown_features.map((f) => (
              <li key={f} className="flex items-start gap-1.5 text-warn-fg">
                <span aria-hidden>?</span> {FEATURE_UNKNOWN[f]}
              </li>
            ))}
            {rec.negative_features.map((f) => (
              <li key={f.feature} className="flex items-start gap-1.5 text-muted" title={f.evidence}>
                <span aria-hidden>✕</span> {FEATURE_NEGATIVE[f.feature]}
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-stroke pt-2.5 text-xs text-muted">
        {osmUrl ? (
          <a className="font-semibold text-graphite underline" href={osmUrl} target="_blank" rel="noopener noreferrer">
            Источник: OpenStreetMap ↗
          </a>
        ) : (
          <span>Источник: OpenStreetMap</span>
        )}
        {website && (
          <a className="underline" href={website} target="_blank" rel="noopener noreferrer nofollow">
            Сайт: {hostOf(website)} ↗
          </a>
        )}
        <span>Данные на {formatDate(rec.as_of)}</span>
        {rec.evidence.length > 0 && (
          <details className="w-full">
            <summary className="cursor-pointer">Поля из источника ({rec.evidence.length})</summary>
            <ul className="mt-1 space-y-0.5">
              {rec.evidence.map((e, i) => (
                <li key={`${e.field}-${i}`} className="break-all">
                  {e.field} = {e.source_value} · {e.license} · {formatDate(e.collected_at)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </footer>
    </article>
  );
});
