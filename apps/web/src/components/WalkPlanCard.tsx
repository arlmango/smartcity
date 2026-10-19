"use client";

import type { PlanStop, WalkPlan } from "@/lib/contracts";
import { formatDistance, openingLabel, pluralRu } from "@/lib/format";
import { CATEGORY_META } from "@/lib/labels";
import { minutesOf } from "@/lib/plan";
import { displayName } from "./RecommendationCard";

// Unknown hours of a square or a monument are not worth a line; of a cafe or museum they are.
const INDOOR = new Set(["cafe", "food", "culture", "mall"]);
const hoursMatter = (s: PlanStop) => s.opening_status === "closed" || (s.opening_status === "unknown" && INDOOR.has(s.category));

/** Timebox plan: 2–3 stops in order. Numbers are the server's router-based estimates. */
export function WalkPlanCard({ plan, shown, busy, stale = false, onShow, onRemove }: {
  plan: WalkPlan;
  shown: boolean;
  busy: boolean;
  stale?: boolean;
  onShow: () => void;
  onRemove: (placeId: string) => void;
}) {
  const n = plan.stops.length;
  return (
    <section
      aria-labelledby="plan-h"
      data-testid="walk-plan"
      className={`sc-card space-y-3 p-4 ${shown ? "border-graphite ring-2 ring-graphite" : ""}`}
    >
      <div>
        <p className="sc-label">План на {plan.time_budget_min} мин</p>
        <h3 id="plan-h" className="text-lg font-extrabold leading-snug">
          {n} {pluralRu(n, "остановка", "остановки", "остановок")} · ≈ {plan.total_min} мин · {formatDistance(plan.distance_m)}
        </h3>
      </div>
      <ol className="space-y-2" aria-label="Остановки плана">
        {plan.stops.map((s, i) => (
          <li key={s.place_id} className="flex items-start gap-3" data-testid="plan-stop">
            <span aria-hidden className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-graphite text-xs font-extrabold text-white">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="break-words font-bold leading-snug">
                <span aria-hidden>{CATEGORY_META[s.category].icon}</span> {displayName(s)}
              </p>
              <p className="text-xs text-muted">
                пешком ≈ {minutesOf(s.leg_in)} мин · на месте ≈ {s.visit_min} мин
                {hoursMatter(s) && ` · ${openingLabel(s.opening_status, null)}`}
              </p>
            </div>
            {n > 1 && (
              <button
                type="button"
                className="min-h-[44px] shrink-0 rounded-control px-2 text-sm font-semibold underline disabled:opacity-50"
                disabled={busy || stale}
                aria-label={`Убрать остановку: ${displayName(s)}`}
                onClick={() => onRemove(s.place_id)}
              >
                Убрать
              </button>
            )}
          </li>
        ))}
        {plan.return_leg && (
          <li className="flex items-start gap-3 text-sm">
            <span aria-hidden className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border-2 border-dashed border-[#7043A0] text-xs">↩</span>
            <p className="pt-1">Обратно к старту ≈ {minutesOf(plan.return_leg)} мин</p>
          </li>
        )}
      </ol>
      <p className="text-xs text-muted">
        Пешком ≈ {plan.walk_min} мин, на местах ≈ {plan.visit_min} мин, запас {plan.buffer_min} мин. Время примерное: зависит от
        темпа, переходов и того, открыт ли вход.
      </p>
      {stale ? (
        <p role="status" data-testid="plan-stale" className="rounded-control bg-warn-bg p-3 text-sm text-warn-fg">
          Старт изменён — этот план построен от прежней точки. Подберите прогулку заново.
        </p>
      ) : (
        <button type="button" className="sc-btn-dark w-full" aria-pressed={shown} onClick={onShow}>
          {shown ? "План показан на карте" : "Показать план на карте"}
        </button>
      )}
      <details className="text-sm">
        <summary className="flex min-h-[44px] cursor-pointer items-center font-semibold">Почему такой план</summary>
        <ul className="list-disc space-y-1 pl-5">
          {plan.why.map((w) => <li key={w}>{w}</li>)}
        </ul>
        {plan.skipped.length > 0 && (
          <>
            <h4 className="sc-label mb-1 mt-3">Не вошли</h4>
            <ul className="space-y-1">
              {plan.skipped.map((s) => (
                <li key={s.place_id}><span className="font-semibold">{s.name}</span> — {s.reason}</li>
              ))}
            </ul>
          </>
        )}
        <p className="mt-3 text-xs text-muted">{plan.method}</p>
      </details>
    </section>
  );
}
