"use client";

import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ApiError, searchPlaces } from "@/lib/api";
import type { PlaceSummary } from "@/lib/contracts";
import { useDebounced } from "@/lib/hooks";
import { CATEGORY_META } from "@/lib/labels";

export function placeDisplayName(p: { name: string; name_is_generic: boolean; category_label: string }): string {
  return p.name_is_generic ? `${p.category_label} · без названия в OSM` : p.name;
}

export function PlaceSearch({ onPick }: { onPick: (p: PlaceSummary) => void }) {
  const [q, setQ] = useState("");
  const debounced = useDebounced(q.trim(), 300);
  const inputId = useId();
  const listId = useId();
  const enabled = debounced.length >= 2;
  const query = useQuery({
    queryKey: ["search", debounced],
    queryFn: ({ signal }) => searchPlaces(debounced, signal),
    enabled,
    staleTime: 60_000,
    retry: 0,
  });
  const items = enabled ? (query.data?.items ?? []) : [];

  return (
    <div>
      <label htmlFor={inputId} className="mb-1 block text-sm font-semibold">
        Найти место в нашей базе
      </label>
      <input
        id={inputId}
        type="search"
        className="sc-input"
        placeholder="Например: MEGA, музей, парк"
        value={q}
        maxLength={100}
        autoComplete="off"
        aria-controls={listId}
        onChange={(e) => setQ(e.target.value)}
      />
      <div id={listId} aria-live="polite" className="mt-1">
        {enabled && query.isFetching && <p className="py-1 text-sm text-muted">Ищем…</p>}
        {enabled && query.isError && (
          <p className="py-1 text-sm text-danger-fg">
            {query.error instanceof ApiError ? query.error.message : "Поиск недоступен."}
          </p>
        )}
        {enabled && query.isSuccess && items.length === 0 && (
          <p className="py-1 text-sm text-muted">Ничего не найдено в собранной базе района.</p>
        )}
        {items.length > 0 && (
          <ul className="mt-1 max-h-56 overflow-auto rounded-control border border-stroke bg-white" aria-label="Результаты поиска">
            {items.slice(0, 8).map((p) => (
              <li key={p.place_id}>
                <button
                  type="button"
                  className="flex min-h-[44px] w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-paper"
                  onClick={() => {
                    onPick(p);
                    setQ("");
                  }}
                >
                  <span aria-hidden>{CATEGORY_META[p.category].icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{placeDisplayName(p)}</span>
                    <span className="block truncate text-xs text-muted">
                      {p.category_label}
                      {p.address ? ` · ${p.address}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
