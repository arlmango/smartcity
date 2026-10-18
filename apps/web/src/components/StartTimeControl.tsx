"use client";

import { useId } from "react";
import { MAX_AHEAD_MS, checkStart, defaultStartInput, toAlmatyInput } from "@/lib/time";

const PROBLEM: Record<string, string> = {
  invalid: "Укажите дату и время.",
  past: "Время уже прошло — выберите время не раньше текущего.",
  too_far: "Можно запланировать не дальше чем на 7 дней вперёд.",
};

export function StartTimeControl({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const inputId = useId();
  const hintId = useId();
  const now = new Date();
  const problem = value !== null ? checkStart(value, now) : null;
  return (
    <fieldset className="space-y-2">
      <legend className="sc-label mb-2">Начало</legend>
      <div className="grid grid-cols-2 gap-1.5 rounded-control bg-[#ECEFE7] p-1">
        <button
          type="button"
          aria-pressed={value === null}
          className="min-h-[44px] rounded-[10px] text-sm font-semibold aria-pressed:bg-graphite aria-pressed:text-white"
          onClick={() => onChange(null)}
        >
          Сейчас
        </button>
        <button
          type="button"
          aria-pressed={value !== null}
          className="min-h-[44px] rounded-[10px] text-sm font-semibold aria-pressed:bg-graphite aria-pressed:text-white"
          onClick={() => onChange(value ?? defaultStartInput(now))}
        >
          Указать время
        </button>
      </div>
      {value !== null && (
        <div>
          <label htmlFor={inputId} className="mb-1 block text-sm">
            Дата и время старта (по времени Астаны)
          </label>
          <input
            id={inputId}
            type="datetime-local"
            className="sc-input"
            value={value}
            min={toAlmatyInput(now)}
            max={toAlmatyInput(new Date(now.getTime() + MAX_AHEAD_MS))}
            step={300}
            aria-invalid={problem !== null}
            aria-describedby={hintId}
            onChange={(e) => onChange(e.target.value)}
          />
          <p id={hintId} className={`mt-1 text-xs ${problem ? "text-danger-fg" : "text-muted"}`}>
            {problem ? PROBLEM[problem] : "Часы работы проверим на время прибытия. До 7 дней вперёд."}
          </p>
        </div>
      )}
    </fieldset>
  );
}
