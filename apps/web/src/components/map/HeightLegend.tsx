"use client";

import type { HeightStats } from "@/lib/mapData";
import { COLORS } from "@/lib/mapStyle";

export function HeightLegend({ stats, defaultOpen }: { stats: HeightStats; defaultOpen: boolean }) {
  const total = stats.height + stats.levels + stats.default;
  if (total === 0) return null;
  const rows = [
    { key: "height", color: COLORS.buildingHeight, label: "из OSM (height)", n: stats.height, dashed: false },
    { key: "levels", color: COLORS.buildingLevels, label: "по этажности", n: stats.levels, dashed: false },
    { key: "default", color: COLORS.buildingDefault, label: "условно 10 м", n: stats.default, dashed: true },
  ];
  return (
    <details
      className="rounded-control border border-stroke bg-white/95 px-3 py-1.5 text-xs shadow-control"
      open={defaultOpen}
      data-testid="height-legend"
    >
      <summary className="flex min-h-[44px] cursor-pointer items-center font-bold">Высоты зданий — приблизительно</summary>
      <ul className="space-y-1 pb-1">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block h-3 w-4 rounded-sm border"
              style={{ background: r.color, borderColor: COLORS.buildingOutline, borderStyle: r.dashed ? "dashed" : "solid", opacity: r.dashed ? 0.75 : 1 }}
            />
            <span>
              {r.label} <span className="text-muted">· {r.n}</span>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
