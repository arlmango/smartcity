"use client";

import { useState } from "react";
import type { CoverageResponse } from "@/lib/contracts";
import type { Origin } from "@/lib/form";
import { formatCoord } from "@/lib/format";
import { PlaceSearch, placeDisplayName } from "./PlaceSearch";

interface Props {
  origin: Origin | null;
  coverage: CoverageResponse | undefined;
  pickActive: boolean;
  warning: string | null;
  onSetOrigin: (o: Origin) => void;
  onStartPick: () => void;
}

const ORIGIN_KIND_LABEL: Record<Origin["kind"], string> = {
  map: "Выбрано на карте",
  center: "Центр карты",
  gps: "Моё местоположение",
  demo: "Демо-точка",
  search: "Место из базы",
};

type GeoState = { phase: "idle" } | { phase: "explain" } | { phase: "locating" } | { phase: "error"; message: string };

function geoErrorMessage(err: GeolocationPositionError | null): string {
  if (!err) return "Браузер не поддерживает определение местоположения. Выберите точку на карте или демо-точку.";
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return "Доступ к геопозиции не разрешён. Ничего страшного: выберите точку на карте, найдите место или используйте демо-точку.";
    case err.POSITION_UNAVAILABLE:
      return "Не удалось определить местоположение. Выберите точку на карте или демо-точку.";
    case err.TIMEOUT:
      return "Определение местоположения заняло слишком много времени. Попробуйте ещё раз или выберите точку на карте.";
    default:
      return "Не удалось определить местоположение.";
  }
}

export function OriginSection({ origin, coverage, pickActive, warning, onSetOrigin, onStartPick }: Props) {
  const [geo, setGeo] = useState<GeoState>({ phase: "idle" });

  const requestGeo = () => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setGeo({ phase: "error", message: geoErrorMessage(null) });
      return;
    }
    setGeo({ phase: "locating" });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({ phase: "idle" });
        onSetOrigin({ lat: pos.coords.latitude, lon: pos.coords.longitude, kind: "gps", label: "Моё местоположение" });
      },
      (err) => setGeo({ phase: "error", message: geoErrorMessage(err) }),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  };

  return (
    <section aria-labelledby="origin-h" className="space-y-3">
      <h3 id="origin-h" className="sc-label">
        Откуда начнём
      </h3>

      <div className="rounded-control border border-stroke bg-white p-3" aria-live="polite">
        {origin ? (
          <div className="flex items-start gap-2.5">
            <span aria-hidden className="mt-1 h-3 w-3 shrink-0 rounded-full border-[3px] border-graphite bg-white" />
            <div className="min-w-0">
              <p className="truncate font-semibold" data-testid="origin-label">
                {origin.label}
              </p>
              <p className="text-xs text-muted">
                {ORIGIN_KIND_LABEL[origin.kind]} · {formatCoord(origin.lat, origin.lon)}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">Точка не выбрана. Нажмите на карту, найдите место или используйте демо-точку.</p>
        )}
      </div>

      {warning && (
        <p role="alert" className="rounded-control bg-warn-bg p-2.5 text-sm text-warn-fg">
          {warning}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="sc-btn" aria-pressed={pickActive} onClick={onStartPick}>
          <span aria-hidden>⌖</span> {pickActive ? "Выбираем…" : "На карте"}
        </button>
        <button
          type="button"
          className="sc-btn"
          aria-expanded={geo.phase === "explain"}
          onClick={() => setGeo({ phase: "explain" })}
          disabled={geo.phase === "locating"}
        >
          <span aria-hidden>◎</span> {geo.phase === "locating" ? "Определяем…" : "Моё местоположение"}
        </button>
      </div>

      {geo.phase === "explain" && (
        <div className="rounded-control border border-stroke bg-paper p-3 text-sm" role="region" aria-label="Запрос геопозиции">
          <p>
            Браузер спросит разрешение на доступ к геопозиции. Координаты используются только для подбора мест: они уходят на
            сервер SmartCity вместе с запросом и не сохраняются. Данные есть только для района EXPO / MEGA.
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className="sc-btn-dark" onClick={requestGeo}>
              Разрешить запрос
            </button>
            <button type="button" className="sc-btn" onClick={() => setGeo({ phase: "idle" })}>
              Отмена
            </button>
          </div>
        </div>
      )}
      {geo.phase === "error" && (
        <p role="alert" className="rounded-control bg-warn-bg p-2.5 text-sm text-warn-fg">
          {geo.message}
        </p>
      )}

      {coverage && (
        <button
          type="button"
          className="sc-btn w-full justify-start"
          onClick={() =>
            onSetOrigin({
              lat: coverage.default_origin.lat,
              lon: coverage.default_origin.lon,
              kind: "demo",
              label: `Демо-точка: ${coverage.default_origin_label}`,
            })
          }
        >
          <span aria-hidden>★</span> Демо-точка {coverage.default_origin_label}
        </button>
      )}

      <PlaceSearch
        onPick={(p) =>
          onSetOrigin({ lat: p.coordinates.lat, lon: p.coordinates.lon, kind: "search", label: placeDisplayName(p) })
        }
      />
    </section>
  );
}
