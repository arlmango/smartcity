"use client";

import type { RecommendResponse, Relaxation } from "@/lib/contracts";
import { REFINEMENT_LABEL, refinementChanges, type RefinementKind } from "@/lib/form";
import type { Constraints } from "@/lib/contracts";
import { RecommendationCard } from "./RecommendationCard";

interface Props {
  response: RecommendResponse;
  constraints: Constraints;
  budget: number | null;
  selectedId: string | null;
  cardRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  busy: boolean;
  cancelled: boolean;
  onSelect: (id: string) => void;
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

const SOURCE_LABEL = { ui: "из настроек", text: "из текста" } as const;

const REFINEMENTS: RefinementKind[] = ["closer", "no_cafe", "indoor_only", "other_options"];

export function ResultsPanel(props: Props) {
  const { response: r } = props;
  const recs = r.recommendations;
  // retrieval_only also marks answers where no generation was needed (no_match, clarification):
  // the "AI unavailable" banner is shown only when places are shown without AI explanations.
  const retrievalOnly = r.mode === "retrieval_only" && recs.length > 0;

  return (
    <div className="space-y-4" data-testid="results">
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
            ИИ временно недоступен — показаны найденные места без объяснений ИИ.
          </p>
        )}

        {r.message && <p className="text-[15px] leading-relaxed">{r.message}</p>}

        {r.warnings.length > 0 && (
          <ul className="space-y-1" aria-label="Предупреждения">
            {r.warnings
              .filter((w) => !(retrievalOnly && /ИИ временно недоступен/.test(w.message)))
              .map((w, i) => (
                <li key={`${w.code}-${i}`} className="rounded-control bg-warn-bg px-3 py-2 text-sm text-warn-fg">
                  {w.message}
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
