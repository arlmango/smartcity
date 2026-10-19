"use client";

import { useElapsed } from "@/lib/hooks";

/**
 * The API does not stream progress, so stages are shown by elapsed time and are
 * labelled as approximate. The pipeline order matches docs/CONTRACTS.md §6.
 */
export const STAGES: Array<{ from: number; label: string }> = [
  { from: 0, label: "Отправляем запрос" },
  { from: 2, label: "Ищем места рядом и проверяем условия" },
  { from: 6, label: "Считаем время и часы работы" },
  { from: 10, label: "Языковая модель формулирует объяснения" },
];

export function stageIndex(elapsed: number): number {
  let idx = 0;
  STAGES.forEach((s, i) => {
    if (elapsed >= s.from) idx = i;
  });
  return idx;
}

export function ProgressPanel({
  startedAt,
  onCancel,
  compact = false,
}: {
  startedAt: number | null;
  onCancel: () => void;
  /** Places are already shown below: only the AI step is still running. */
  compact?: boolean;
}) {
  const elapsed = useElapsed(startedAt);
  const current = stageIndex(elapsed);
  if (compact) {
    return (
      <section className="sc-card flex items-center justify-between gap-3 p-3" data-testid="progress" aria-live="polite">
        <p className="text-sm">
          <span className="font-semibold">ИИ готовит объяснения…</span>{" "}
          <span className="tabular-nums text-muted">{elapsed} с</span>
        </p>
        <button type="button" className="sc-btn shrink-0" onClick={onCancel}>
          Отменить
        </button>
      </section>
    );
  }
  return (
    <section className="sc-card space-y-4 p-4" aria-labelledby="progress-h" data-testid="progress">
      <div className="flex items-center justify-between gap-2">
        <h2 id="progress-h" className="text-lg font-bold">
          Подбираем прогулку…
        </h2>
        <span className="tabular-nums text-sm text-muted" aria-live="off">
          {elapsed} с
        </span>
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {STAGES[current]?.label}
      </div>
      <ol className="space-y-2">
        {STAGES.map((s, i) => (
          <li key={s.label} className="flex items-center gap-2.5 text-sm">
            <span
              aria-hidden
              className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold ${
                i < current ? "bg-graphite text-white" : i === current ? "border-2 border-graphite" : "border-2 border-stroke"
              }`}
            >
              {i < current ? "✓" : ""}
            </span>
            <span className={i <= current ? "font-semibold" : "text-muted"}>{s.label}</span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted">
        Этапы примерные. Локальная модель на процессоре может отвечать 30–90 секунд; если ИИ недоступен, покажем найденные места
        без объяснений.
      </p>
      <button type="button" className="sc-btn w-full" onClick={onCancel}>
        Отменить
      </button>
    </section>
  );
}
