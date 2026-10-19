"use client";

import type { RecommendResponse, Relaxation } from "@/lib/contracts";
import { REFINEMENT_LABEL, refinementChanges, type RefinementKind } from "@/lib/form";
import type { Constraints } from "@/lib/contracts";
import { formatAlmaty } from "@/lib/time";
import { AlternativeComparison } from "./AlternativeComparison";
import { RecommendationCard } from "./RecommendationCard";
import { WalkPlanCard } from "./WalkPlanCard";

interface Props {
  response: RecommendResponse;
  constraints: Constraints;
  budget: number | null;
  /** start_time of the request that produced this response (null = "now"). */
  startTime: string | null;
  selectedId: string | null;
  cardRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  busy: boolean;
  /** Preliminary answer: places found by retrieval, the model is still generating. */
  pending?: boolean;
  /** Shown above the cards, e.g. when explanations failed after the places were found. */
  note?: string | null;
  cancelled: boolean;
  onSelect: (id: string) => void;
  /** The timebox plan is the selected item on the map. */
  planShown: boolean;
  onShowPlan: () => void;
  onRemoveStop: (placeId: string) => void;
  onRefine: (kind: RefinementKind) => void;
  onRelax: (r: Relaxation) => void;
  onEdit: () => void;
  onReset: () => void;
}

const STATUS_TITLE: Record<RecommendResponse["status"], string> = {
  ok: "Нашли варианты",
  degraded: "Варианты с ограничениями",
  no_match: "Подходящих мест не нашлось",
  needs_clarification: "Нужно уточнение",
};

const AI_DOWN_CODES = new Set(["llm_unavailable", "llm_busy", "ai_pending"]);

const SOURCE_LABEL = { ui: "из настроек", text: "из текста" } as const;

const REFINEMENTS: RefinementKind[] = ["closer", "no_cafe", "indoor_only", "other_options"];

export function ResultsPanel(props: Props) {
  const { response: r } = props;
  const recs = r.recommendations;
  const diagnosticWarnings = r.warnings.filter((w) => w.code.startsWith("embeddings_") || w.code === "llm_text_rejected" || w.code === "routing_excluded");
  const visibleWarning = (code: string, message: string) => code === "straight_line_estimate" || code === "routing_unavailable"
    ? "Пеший путь недоступен. Оценка по прямой может занижать время в пути."
    : code === "routing_excluded" ? "Некоторые места не показаны: не удалось построить пеший путь." : message;
  // retrieval_only also marks answers where no generation was needed (no_match, clarification):
  // the "AI unavailable" banner is shown only when places are shown without AI explanations.
  const retrievalOnly = r.mode === "retrieval_only" && recs.length > 0;
  // A busy local model is a different reason than an outage: say which one it is.
  const busy = r.warnings.find((w) => w.code === "llm_busy");
  const bannerText = props.pending
    ? "Места уже найдены поиском по базе — ИИ ещё готовит объяснения."
    : busy
      ? busy.message
      : "ИИ временно недоступен — показаны найденные места без объяснений ИИ.";

  return (
    <div className="space-y-4" data-testid="results">
      {/* The decision first: the plan, then the summary with its caveats. */}
      {r.plan && (
        <WalkPlanCard plan={r.plan} shown={props.planShown} busy={props.busy && !props.pending} onShow={props.onShowPlan} onRemove={props.onRemoveStop} />
      )}
      <section className="sc-card space-y-3 p-4" aria-labelledby="summary-h">
        <div className="flex items-start justify-between gap-2">
          <h2 id="summary-h" className="text-xl font-extrabold leading-tight" data-status={r.status}>
            {STATUS_TITLE[r.status]}
            {recs.length > 0 && <span className="ml-1 text-muted">· {recs.length}</span>}
          </h2>
        </div>

        {props.cancelled && (
          <p className="rounded-control bg-paper p-2 text-sm text-muted" role="status">
            Новый запрос отменён — показан предыдущий результат.
          </p>
        )}

        {retrievalOnly && (
          <p role="note" data-testid="retrieval-only" className="rounded-control border border-warn-fg/30 bg-warn-bg p-3 text-sm font-semibold text-warn-fg">
            {bannerText}
          </p>
        )}

        {props.note && (
          <p role="status" data-testid="partial-note" className="rounded-control border border-warn-fg/30 bg-warn-bg p-3 text-sm font-semibold text-warn-fg">
            {props.note}
          </p>
        )}

        {r.message && !props.pending && !(retrievalOnly && (r.message === bannerText || r.message.startsWith("ИИ временно недоступен"))) && (
          <p className="text-[15px] leading-relaxed">{r.message}</p>
        )}

        <details className="text-xs text-muted">
          <summary className="min-h-[44px] cursor-pointer py-3">Подробнее о подборе</summary>
        <p data-testid="hours-checked-at">
          {props.startTime
            ? `Часы работы проверены на время прибытия при старте ${formatAlmaty(props.startTime)} (время Астаны).`
            : "Часы работы проверены на время прибытия при старте сейчас."}
        </p>

          {diagnosticWarnings.map((w) => <p key={w.code} className="mt-2">{w.message}</p>)}
        </details>

        {r.warnings.length > 0 && (
          <ul className="space-y-1" aria-label="Предупреждения">
            {r.warnings
              // the banner already says it: do not repeat AI-unavailable/busy notices or the message
              .filter((w) => !(retrievalOnly && (AI_DOWN_CODES.has(w.code) || /ИИ временно недоступен/.test(w.message))))
              .filter((w) => w.message !== r.message && (!diagnosticWarnings.includes(w) || w.code === "routing_excluded"))
              .map((w, i) => (
                <li key={`${w.code}-${i}`} className="rounded-control bg-warn-bg px-3 py-2 text-sm text-warn-fg">
                  {visibleWarning(w.code, w.message)}
                </li>
              ))}
          </ul>
        )}

        {(r.constraints_applied.hard.length > 0 || r.constraints_applied.preferences.length > 0) && (
          <details className="text-sm">
            <summary className="flex min-h-[44px] cursor-pointer items-center font-semibold">Как мы поняли запрос</summary>
            {r.constraints_applied.interpreted_query && (
              <p className="mb-2 text-muted">
                «{r.constraints_applied.interpreted_query}» <span className="sc-tag-ai">пересказ</span>
              </p>
            )}
            {r.constraints_applied.hard.length > 0 && (
              <>
                <h3 className="sc-label mb-1">Обязательно</h3>
                <ul className="mb-2 flex flex-wrap gap-1.5">
                  {r.constraints_applied.hard.map((c, i) => (
                    <li key={`${c.kind}-${i}`} className="rounded-full border border-graphite px-2.5 py-1 text-xs font-semibold">
                      {c.label} <span className="font-normal text-muted">· {SOURCE_LABEL[c.source]}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {r.constraints_applied.preferences.length > 0 && (
              <>
                <h3 className="sc-label mb-1">Пожелания (влияют на порядок)</h3>
                <ul className="flex flex-wrap gap-1.5">
                  {r.constraints_applied.preferences.map((p, i) => (
                    <li key={`${p}-${i}`} className="rounded-full border border-stroke px-2.5 py-1 text-xs">
                      {p}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </details>
        )}

        {r.status === "needs_clarification" && (
          <button type="button" className="sc-btn-dark w-full" onClick={props.onEdit}>
            Изменить условия
          </button>
        )}

        {r.suggested_relaxations.length > 0 && (
          <div>
            <h3 className="sc-label mb-2">Можно ослабить условия</h3>
            <ul className="space-y-2">
              {r.suggested_relaxations.map((rx, i) => (
                <li key={`${rx.code}-${i}`}>
                  <button
                    type="button"
                    className="sc-btn w-full justify-start text-left"
                    disabled={props.busy}
                    onClick={() => props.onRelax(rx)}
                  >
                    {rx.message}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {!r.plan && r.plan_note && (
        <p data-testid="plan-note" className="rounded-control border border-stroke bg-white p-3 text-sm text-muted">
          {r.plan_note}
        </p>
      )}

      <AlternativeComparison recs={recs} budget={props.budget} selectedId={props.selectedId} onSelect={props.onSelect} />

      {recs.length > 0 && (
        <ol className="space-y-3" aria-label="Рекомендации">
          {recs.map((rec, i) => (
            <li key={rec.place_id}>
              <RecommendationCard
                ref={(el) => {
                  if (el) props.cardRefs.current.set(rec.place_id, el);
                  else props.cardRefs.current.delete(rec.place_id);
                }}
                rec={rec}
                index={i}
                selected={props.selectedId === rec.place_id}
                budget={props.budget}
                retrievalOnly={retrievalOnly}
                pending={props.pending}
                onSelect={props.onSelect}
              />
            </li>
          ))}
        </ol>
      )}

      {recs.length > 0 && (
        <section aria-labelledby="refine-h" className="space-y-2">
          <h3 id="refine-h" className="sc-label">
            Уточнить
          </h3>
          <div className="flex flex-wrap gap-2">
            {REFINEMENTS.map((k) => {
              const useful = refinementChanges(k, props.constraints, recs);
              return (
                <button
                  key={k}
                  type="button"
                  className="sc-chip"
                  disabled={props.busy || !useful}
                  title={useful ? undefined : "Это условие уже учтено"}
                  onClick={() => props.onRefine(k)}
                >
                  {REFINEMENT_LABEL[k]}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted">Уточнения сохраняют прежние обязательные условия.</p>
        </section>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="sc-btn" onClick={props.onEdit}>
          Изменить запрос
        </button>
        <button type="button" className="sc-btn" onClick={props.onReset}>
          Начать заново
        </button>
      </div>
    </div>
  );
}
