"use client";

import type { Recommendation } from "@/lib/contracts";
import { formatDistanceWithMethod, openingLabel, timingTotalLabel } from "@/lib/format";
import { displayName } from "./RecommendationCard";

/** Compare independent alternatives using the same server facts as the full cards. */
export function AlternativeComparison({ recs, budget, selectedId, onSelect }: {
  recs: Recommendation[];
  budget: number | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (recs.length < 2) return null;
  return (
    <section aria-label="Сравнить варианты" className="space-y-2">
      <h3 className="text-base font-bold">Сравнить варианты</h3>
      <p className="text-xs text-muted">Выберите одно место. Это отдельные варианты, а не остановки одной прогулки. Время приблизительное.</p>
      <ol className="divide-y divide-stroke border-y border-stroke">
        {recs.map((rec, index) => (
          <li key={rec.place_id}>
            <button
              type="button"
              aria-pressed={selectedId === rec.place_id}
              className="w-full rounded-control px-2 py-3 text-left hover:bg-white aria-pressed:bg-lime"
              onClick={() => onSelect(rec.place_id)}
            >
              <span className="block break-words text-sm font-bold">{index + 1}. {displayName(rec)}</span>
              <span className="block text-xs">{formatDistanceWithMethod(rec.distance.meters, rec.distance.method)} · {openingLabel(rec.opening_status, rec.opening_hours_raw)}</span>
              <span className="mt-2 grid grid-cols-4 gap-1 text-xs tabular-nums">
                <span>Туда<strong className="block">≈ {rec.timing.outbound_min} мин</strong></span>
                <span>Визит<strong className="block">≈ {rec.timing.visit_min} мин</strong></span>
                <span>Обратно<strong className="block">{rec.timing.return_min === null ? "не учтено" : `≈ ${rec.timing.return_min} мин`}</strong></span>
                <span>Запас<strong className="block">{rec.timing.buffer_min} мин</strong></span>
              </span>
              <span className="mt-1 block text-xs font-semibold">{timingTotalLabel(rec.timing, budget)}</span>
              <span className="mt-1 block text-xs underline">{selectedId === rec.place_id ? "Выбрано на карте" : "Выбрать на карте"}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
