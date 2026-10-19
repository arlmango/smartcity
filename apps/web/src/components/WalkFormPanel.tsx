"use client";

import { useId, useState } from "react";
import { INTERESTS, type CoverageResponse, type Feature } from "@/lib/contracts";
import {
  FOOD_CATEGORIES,
  clampBudget,
  excludesAll,
  toggle,
  validateForm,
  withExcludedCategories,
  withRequiredFeature,
  type Origin,
  type WalkForm,
} from "@/lib/form";
import { formatDistance } from "@/lib/format";
import {
  CATEGORY_META,
  FEATURE_LABEL,
  INTEREST_LABEL,
  QUERY_MAX,
  REQUIRED_FEATURE_OPTIONS,
  TIME_MAX,
  TIME_MIN,
  TIME_PRESETS,
} from "@/lib/labels";
import { OriginSection } from "./OriginSection";
import { StartTimeControl } from "./StartTimeControl";

interface Props {
  form: WalkForm;
  setForm: (updater: (f: WalkForm) => WalkForm) => void;
  coverage: CoverageResponse | undefined;
  pickActive: boolean;
  originWarning: string | null;
  onSetOrigin: (o: Origin) => void;
  onStartPick: () => void;
  onSubmit: () => void;
  blockedReason: string | null;
  externalProvider?: boolean;
}

export function WalkFormPanel(props: Props) {
  const { form, setForm, blockedReason } = props;
  const queryId = useId();
  const customId = useId();
  const hintId = useId();
  const [customText, setCustomText] = useState<string>(String(form.timeBudget));
  const problems = validateForm(form);
  const c = form.constraints;
  const isPreset = (TIME_PRESETS as readonly number[]).includes(form.timeBudget);
  const hardCount =
    c.required_features.length + (c.must_be_open ? 1 : 0) + (excludesAll(c, FOOD_CATEGORIES) ? 1 : 0);

  const setFeature = (f: Feature, on: boolean) =>
    setForm((s) => ({ ...s, constraints: withRequiredFeature(s.constraints, f, on) }));

  const submitHint =
    blockedReason ??
    (problems.includes("no_origin")
      ? "Сначала выберите точку старта."
      : problems.includes("bad_budget")
        ? `Время должно быть от ${TIME_MIN} до ${TIME_MAX} минут.`
        : problems.includes("query_too_long")
          ? `Текст длиннее ${QUERY_MAX} символов.`
          : problems.includes("bad_start")
            ? "Проверьте время начала прогулки."
            : null);

  return (
    <form
      className="space-y-6"
      aria-labelledby="form-h"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!submitHint) props.onSubmit();
      }}
    >
      <div>
        <h2 id="form-h" className="text-[26px] font-extrabold leading-tight tracking-tight">
          Куда пойдём?
        </h2>
        <p className="mt-1 text-sm text-muted">Опишите прогулку — подберём 1–3 реальных места рядом и честно скажем, что не подтверждено.</p>
      </div>

      <OriginSection
        origin={form.origin}
        coverage={props.coverage}
        pickActive={props.pickActive}
        warning={props.originWarning}
        onSetOrigin={props.onSetOrigin}
        onStartPick={props.onStartPick}
      />

      <section className="space-y-2">
        <label htmlFor={queryId} className="sc-label block">
          Что хочется
        </label>
        <textarea
          id={queryId}
          className="sc-input min-h-[96px] resize-y"
          placeholder="Например: хочу кофе и немного прогуляться, вернуться сюда"
          value={form.query}
          maxLength={QUERY_MAX}
          aria-describedby={`${queryId}-count`}
          onChange={(e) => setForm((s) => ({ ...s, query: e.target.value.slice(0, QUERY_MAX) }))}
        />
        <p id={`${queryId}-count`} className="text-right text-xs text-muted">
          {form.query.length} / {QUERY_MAX}
        </p>
        <fieldset>
          <legend className="sr-only">Интересы</legend>
          <div className="flex flex-wrap gap-2">
            {INTERESTS.map((i) => (
              <button
                key={i}
                type="button"
                className="sc-chip"
                aria-pressed={form.interests.includes(i)}
                onClick={() => setForm((s) => ({ ...s, interests: toggle(s.interests, i) }))}
              >
                {INTEREST_LABEL[i]}
              </button>
            ))}
          </div>
        </fieldset>
      </section>

      <fieldset className="space-y-2">
        <legend className="sc-label mb-2">Сколько есть времени</legend>
        <div className="grid grid-cols-4 gap-1.5 rounded-control bg-[#ECEFE7] p-1">
          {TIME_PRESETS.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={form.timeBudget === t}
              className="min-h-[44px] rounded-[10px] text-sm font-semibold text-graphite aria-pressed:bg-graphite aria-pressed:text-white"
              onClick={() => {
                setForm((s) => ({ ...s, timeBudget: t }));
                setCustomText(String(t));
              }}
            >
              {t} мин
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={customId} className="text-sm">
            Своё время
          </label>
          <input
            id={customId}
            type="number"
            inputMode="numeric"
            min={TIME_MIN}
            max={TIME_MAX}
            step={5}
            className={`sc-input w-24 ${!isPreset ? "border-graphite" : ""}`}
            value={customText}
            aria-describedby={`${customId}-hint`}
            onChange={(e) => {
              setCustomText(e.target.value);
              const n = Number(e.target.value);
              if (e.target.value !== "" && Number.isFinite(n)) setForm((s) => ({ ...s, timeBudget: Math.round(n) }));
            }}
            onBlur={() => {
              const n = Number(customText);
              const v = Number.isFinite(n) && customText !== "" ? clampBudget(n) : form.timeBudget;
              setCustomText(String(v));
              setForm((s) => ({ ...s, timeBudget: clampBudget(v) }));
            }}
          />
          <span id={`${customId}-hint`} className="text-xs text-muted">
            мин, от {TIME_MIN} до {TIME_MAX}
          </span>
        </div>
      </fieldset>

      <StartTimeControl value={form.startTime} onChange={(v) => setForm((s) => ({ ...s, startTime: v }))} />

      <section className="space-y-3">
        <label className="flex min-h-[44px] cursor-pointer items-center justify-between gap-3">
          <span>
            <span className="block font-semibold">Вернуться сюда</span>
            <span className="block text-xs text-muted">Обратная дорога входит в бюджет времени</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="peer sr-only"
            checked={form.returnToStart}
            onChange={(e) => setForm((s) => ({ ...s, returnToStart: e.target.checked }))}
          />
          <span
            aria-hidden
            className="relative h-7 w-12 shrink-0 rounded-full bg-[#C9D0C5] transition-colors after:absolute after:left-1 after:top-1 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-graphite peer-checked:after:translate-x-5 peer-checked:after:bg-lime peer-focus-visible:outline peer-focus-visible:outline-[3px] peer-focus-visible:outline-offset-2 peer-focus-visible:outline-graphite"
          />
        </label>
        <div className="flex items-center justify-between gap-3 rounded-control bg-[#ECEFE7] px-3 py-2.5 text-sm">
          <span className="font-semibold">Только пешком</span>
          <span className="text-muted">другой транспорт не поддерживается</span>
        </div>
      </section>

      <details className="group rounded-control border border-stroke bg-white" open={hardCount > 0 ? true : undefined}>
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between px-3 font-semibold">
          <span>
            Обязательные условия{" "}
            {hardCount > 0 && <span className="ml-1 rounded-full bg-graphite px-2 py-0.5 text-xs text-white">{hardCount}</span>}
          </span>
          <span aria-hidden className="transition-transform group-open:rotate-180">
            ▾
          </span>
        </summary>
        <div className="space-y-1 border-t border-stroke px-3 py-2">
          <p className="pb-1 text-xs text-muted">
            Покажем только места, где эти условия подтверждены.
          </p>
          {REQUIRED_FEATURE_OPTIONS.map((f) => (
            <label key={f} className="flex min-h-[44px] cursor-pointer items-center gap-3 text-sm">
              <input
                type="checkbox"
                className="h-5 w-5 accent-graphite"
                checked={c.required_features.includes(f)}
                onChange={(e) => setFeature(f, e.target.checked)}
              />
              {f === "kids" ? "Для детей" : FEATURE_LABEL[f]}
            </label>
          ))}
          <label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="h-5 w-5 accent-graphite"
              checked={c.must_be_open}
              onChange={(e) => setForm((s) => ({ ...s, constraints: { ...s.constraints, must_be_open: e.target.checked } }))}
            />
            Открыто во время визита
          </label>
          <label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="h-5 w-5 accent-graphite"
              checked={excludesAll(c, FOOD_CATEGORIES)}
              onChange={(e) =>
                setForm((s) => ({ ...s, constraints: withExcludedCategories(s.constraints, FOOD_CATEGORIES, e.target.checked) }))
              }
            />
            Без кафе и еды
          </label>
        </div>
      </details>

      <ActiveExtras form={form} setForm={setForm} />

      <div className="space-y-2">
        <button type="submit" className="sc-cta" disabled={!!submitHint} aria-describedby={submitHint ? hintId : undefined}>
          Подобрать прогулку <span aria-hidden>↗</span>
        </button>
        {submitHint && (
          <p id={hintId} className="text-sm text-muted">
            {submitHint}
          </p>
        )}
        {props.externalProvider && (
          <p className="rounded-control bg-warn-bg p-2 text-xs font-semibold text-warn-fg" data-testid="external-provider-note">
            Текст запроса и выбранная точка обрабатываются внешним ИИ-провайдером (см. «О данных»).
          </p>
        )}
        <p className="text-xs text-muted">Время прогулки приблизительное.</p>
      </div>
    </form>
  );
}

/** Conditions added by quick refinements that have no checkbox: shown and removable. */
function ActiveExtras({ form, setForm }: Pick<Props, "form" | "setForm">) {
  const c = form.constraints;
  const otherExcluded = c.exclude_categories.filter((x) => x !== "cafe" && x !== "food");
  const onlyCafeExcluded = c.exclude_categories.includes("cafe") && !c.exclude_categories.includes("food");
  const items: Array<{ key: string; label: string; clear: () => void }> = [];
  if (c.max_distance_m !== null)
    items.push({
      key: "dist",
      label: `Не дальше ${formatDistance(c.max_distance_m)} по прямой`,
      clear: () => setForm((s) => ({ ...s, constraints: { ...s.constraints, max_distance_m: null } })),
    });
  if (c.exclude_place_ids.length > 0)
    items.push({
      key: "ids",
      label: `Скрыто показанных мест: ${c.exclude_place_ids.length}`,
      clear: () => setForm((s) => ({ ...s, constraints: { ...s.constraints, exclude_place_ids: [] } })),
    });
  if (onlyCafeExcluded)
    items.push({
      key: "nocafe",
      label: "Без кафе",
      clear: () => setForm((s) => ({ ...s, constraints: withExcludedCategories(s.constraints, ["cafe"], false) })),
    });
  for (const cat of otherExcluded)
    items.push({
      key: `ex-${cat}`,
      label: `Без: ${CATEGORY_META[cat].label}`,
      clear: () => setForm((s) => ({ ...s, constraints: withExcludedCategories(s.constraints, [cat], false) })),
    });
  for (const cat of c.include_categories)
    items.push({
      key: `in-${cat}`,
      label: `Только: ${CATEGORY_META[cat].label}`,
      clear: () =>
        setForm((s) => ({
          ...s,
          constraints: { ...s.constraints, include_categories: s.constraints.include_categories.filter((x) => x !== cat) },
        })),
    });
  if (c.preferred_features.length > 0)
    items.push({
      key: "pref",
      label: `Желательно: ${c.preferred_features.map((f) => FEATURE_LABEL[f]).join(", ")}`,
      clear: () => setForm((s) => ({ ...s, constraints: { ...s.constraints, preferred_features: [] } })),
    });
  if (items.length === 0) return null;
  return (
    <section aria-label="Дополнительные условия">
      <h3 className="sc-label mb-2">Дополнительные условия</h3>
      <ul className="flex flex-wrap gap-2">
        {items.map((it) => (
          <li key={it.key}>
            <button type="button" className="sc-chip" onClick={it.clear} aria-label={`Убрать условие: ${it.label}`}>
              {it.label} <span aria-hidden>✕</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
