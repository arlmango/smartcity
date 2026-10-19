"use client";

import type { HeightStats } from "@/lib/mapData";
import { COLORS } from "@/lib/mapStyle";

const fmt = (n: number) => n.toLocaleString("ru-RU");
const decimal = (n: number) => n.toLocaleString("ru-RU", { maximumFractionDigits: 1 });

/**
 * Building heights are partly estimates. The legend mirrors the map's coding exactly: measured heights
 * are solid and shaded by height; estimates and the conventional default are light and translucent
 * (dashed outlines in 2D). Counts per height source come from /api/basemap.
 */
export function HeightLegend({
  stats,
  levelHeight,
  defaultHeight,
  cityWide,
  stylised,
  defaultOpen,
}: {
  stats: HeightStats;
  levelHeight: number;
  defaultHeight: number;
  cityWide: boolean;
  stylised: boolean;
  defaultOpen: boolean;
}) {
  const total = stats.height + stats.levels + (stats.estimate ?? 0) + stats.default;
  if (total === 0) return null;
  const groups = [
    {
      key: "measured",
      title: "Измерено — сплошные",
      swatch: `linear-gradient(90deg, ${COLORS.buildingEstimate}, ${COLORS.buildingHeight}, #C9D3DA)`,
      dashed: false,
      rows: [
        { key: "height", label: "высота из OSM", n: stats.height },
        { key: "levels", label: `этажи × ${decimal(levelHeight)} м`, n: stats.levels },
      ],
    },
    {
      key: "approx",
      title: "Оценки — светлые, полупрозрачные",
      swatch: COLORS.buildingDefault,
      dashed: true,
      rows: [
        { key: "estimate", label: "по типу или площади", n: stats.estimate ?? 0 },
        { key: "default", label: `нет данных — условно ${decimal(defaultHeight)} м`, n: stats.default },
      ],
    },
  ];
  return (
    <details
      className="max-w-[17rem] rounded-control border border-stroke bg-white/95 px-3 py-1.5 text-xs shadow-control"
      open={defaultOpen}
      data-testid="height-legend"
    >
      <summary className="flex min-h-[44px] cursor-pointer items-center font-bold">Высоты зданий — приблизительно</summary>
      {groups.map((g) => (
        <div key={g.key} className="pb-1">
          <p className="flex items-center gap-2 font-semibold">
            <span
              aria-hidden
              className="inline-block h-3 w-5 shrink-0 rounded-sm border"
              style={{ background: g.swatch, borderColor: COLORS.buildingOutline, borderStyle: g.dashed ? "dashed" : "solid", opacity: g.dashed ? 0.8 : 1 }}
            />
            {g.title}
          </p>
          <ul className="ml-7 space-y-0.5">
            {g.rows.map((r) => (
              <li key={r.key}>
                {r.label} <span className="text-muted">· {fmt(r.n)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="pb-1.5 text-[11px] leading-snug text-muted">
        {cityWide ? `${fmt(total)} контуров OSM, вся Астана.` : "Контуры OSM в районе базы."} Оценки — не измерения. Крыши
        приближены по roof:shape, фасадов нет.{stylised ? " Нур Алем — стилизация, не точная модель." : ""}
      </p>
    </details>
  );
}
