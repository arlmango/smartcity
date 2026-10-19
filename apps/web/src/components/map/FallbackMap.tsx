"use client";

import type { Feature, Position } from "geojson";
import { useMemo, useRef, useState } from "react";
import type { Recommendation } from "@/lib/contracts";
import type { Origin } from "@/lib/form";
import { collectionBounds, type BuildingProps, type LayerResult, type MapLayer } from "@/lib/mapData";
import { COLORS, INITIAL_VIEW } from "@/lib/mapStyle";
import { displayName } from "../RecommendationCard";
import { MapControlButton } from "./MapControlButton";

/**
 * Simple 2D SVG renderer of the same GeoJSON layers, used when WebGL is unavailable
 * or the MapLibre map fails. Supports origin picking, result markers and zoom/pan.
 */
interface Props {
  layers: Partial<Record<MapLayer, LayerResult>>;
  origin: Origin | null;
  recs: Recommendation[];
  selectedId: string | null;
  pickActive: boolean;
  reason: string;
  onPick: (lon: number, lat: number) => void;
  onSelectPlace: (id: string) => void;
}

const W = 1000;

export function FallbackMap(props: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const bounds = useMemo(() => {
    const b =
      collectionBounds(props.layers.coverage?.data) ??
      collectionBounds(props.layers.buildings?.data) ??
      ([INITIAL_VIEW.center[0] - 0.015, INITIAL_VIEW.center[1] - 0.01, INITIAL_VIEW.center[0] + 0.015, INITIAL_VIEW.center[1] + 0.01] as const);
    return b;
  }, [props.layers.coverage, props.layers.buildings]);
  const [minX, minY, maxX, maxY] = bounds;
  const kx = Math.cos((((minY + maxY) / 2) * Math.PI) / 180);
  const scale = W / ((maxX - minX) * kx || 1);
  const H = Math.max(1, (maxY - minY) * scale);
  const proj = (p: Position): [number, number] => [((p[0] as number) - minX) * kx * scale, (maxY - (p[1] as number)) * scale];
  const unproj = (x: number, y: number): [number, number] => [x / scale / kx + minX, maxY - y / scale];

  const [view, setView] = useState<{ cx: number; cy: number; z: number }>({ cx: W / 2, cy: H / 2, z: 1 });
  const vw = W / view.z;
  const vh = H / view.z;
  const viewBox = `${view.cx - vw / 2} ${view.cy - vh / 2} ${vw} ${vh}`;
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);

  const ringPath = (ring: Position[]) => ring.map((p, i) => `${i ? "L" : "M"}${proj(p).map((v) => v.toFixed(1)).join(" ")}`).join(" ") + " Z";
  const linePath = (line: Position[]) => line.map((p, i) => `${i ? "L" : "M"}${proj(p).map((v) => v.toFixed(1)).join(" ")}`).join(" ");
  const geomPath = (f: Feature): string => {
    const g = f.geometry;
    switch (g?.type) {
      case "Polygon":
        return g.coordinates.map(ringPath).join(" ");
      case "MultiPolygon":
        return g.coordinates.map((poly) => poly.map(ringPath).join(" ")).join(" ");
      case "LineString":
        return linePath(g.coordinates);
      case "MultiLineString":
        return g.coordinates.map(linePath).join(" ");
      default:
        return "";
    }
  };

  const paths = useMemo(() => {
    const mk = (layer: MapLayer) => (props.layers[layer]?.data.features ?? []).map((f) => ({ f, d: geomPath(f) }));
    return { green: mk("green"), water: mk("water"), roads: mk("roads"), buildings: mk("buildings"), coverage: mk("coverage") };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.layers, minX, minY, maxX, maxY]);

  const toSvg = (clientX: number, clientY: number): [number, number] | null => {
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m) return null;
    const pt = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return [pt.x, pt.y];
  };

  const zoomBy = (f: number) => setView((v) => ({ ...v, z: Math.min(12, Math.max(1, v.z * f)) }));
  const fit = () => {
    const pts = props.recs.map((r) => proj([r.coordinates.lon, r.coordinates.lat]));
    if (props.origin) pts.push(proj([props.origin.lon, props.origin.lat]));
    if (pts.length === 0) return setView({ cx: W / 2, cy: H / 2, z: 1 });
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs) + 120;
    const h = Math.max(...ys) - Math.min(...ys) + 120;
    setView({
      cx: (Math.max(...xs) + Math.min(...xs)) / 2,
      cy: (Math.max(...ys) + Math.min(...ys)) / 2,
      z: Math.min(12, Math.max(1, Math.min(W / w, H / h))),
    });
  };

  return (
    <div className="absolute inset-0 bg-[#EEF0EA]" data-testid="fallback-map">
      <svg
        ref={svgRef}
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        className={`h-full w-full touch-none select-none ${props.pickActive ? "cursor-crosshair" : "cursor-grab"}`}
        role="img"
        aria-label="Упрощённая 2D-карта района (без WebGL)"
        onPointerDown={(e) => {
          if ((e.target as Element).closest("[data-marker]")) return;
          drag.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, moved: false };
          (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          const svg = svgRef.current;
          if (!d || !svg) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
          if (!d.moved) return;
          const k = vw / svg.clientWidth;
          setView((v) => ({ ...v, cx: d.cx - dx * k, cy: d.cy - dy * k }));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d?.moved || !props.pickActive) return;
          if ((e.target as Element).closest("[data-marker]")) return;
          const p = toSvg(e.clientX, e.clientY);
          if (p) {
            const [lon, lat] = unproj(p[0], p[1]);
            props.onPick(lon, lat);
          }
        }}
        onWheel={(e) => zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2)}
      >
        {paths.green.map(({ d }, i) => (
          <path key={`g${i}`} d={d} fill={COLORS.green} fillRule="evenodd" />
        ))}
        {paths.water.map(({ f, d }, i) =>
          f.geometry.type.includes("Polygon") ? (
            <path key={`w${i}`} d={d} fill={COLORS.water} fillRule="evenodd" />
          ) : (
            <path key={`w${i}`} d={d} fill="none" stroke={COLORS.water} strokeWidth={3} />
          ),
        )}
        {paths.roads.map(({ d }, i) => (
          <path key={`r${i}`} d={d} fill="none" stroke={COLORS.roadCasing} strokeWidth={3.5} strokeLinecap="round" />
        ))}
        {paths.roads.map(({ d }, i) => (
          <path key={`ri${i}`} d={d} fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" />
        ))}
        {paths.buildings.map(({ f, d }, i) => {
          const src = (f.properties as BuildingProps).height_source;
          return (
            <path
              key={`b${i}`}
              d={d}
              fillRule="evenodd"
              fill={src === "height" ? COLORS.buildingHeight : src === "levels" ? COLORS.buildingLevels : COLORS.buildingDefault}
              stroke={COLORS.buildingOutline}
              strokeWidth={0.4}
            />
          );
        })}
        {paths.coverage.map(({ d }, i) => (
          <path key={`c${i}`} d={d} fill="none" stroke={COLORS.coverage} strokeOpacity={0.55} strokeDasharray="6 4" strokeWidth={1.5} />
        ))}
        {props.origin &&
          (() => {
            const [x, y] = proj([props.origin.lon, props.origin.lat]);
            const r = 9 / view.z;
            return (
              <g data-testid="origin-marker" aria-label={`Точка старта: ${props.origin.label}`} role="img">
                <circle cx={x} cy={y} r={r} fill="#fff" stroke={COLORS.coverage} strokeWidth={5 / view.z} />
              </g>
            );
          })()}
        {props.recs.map((rec, i) => {
          const [x, y] = proj([rec.coordinates.lon, rec.coordinates.lat]);
          const sel = rec.place_id === props.selectedId;
          const r = 16 / view.z;
          return (
            <g
              key={rec.place_id}
              data-marker
              data-testid="rec-marker"
              data-place-id={rec.place_id}
              role="button"
              tabIndex={0}
              aria-pressed={sel}
              aria-label={`${i + 1}. ${displayName(rec)} — открыть карточку`}
              className="cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                props.onSelectPlace(rec.place_id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  props.onSelectPlace(rec.place_id);
                }
              }}
            >
              <circle cx={x} cy={y} r={r} fill={sel ? "#D9F66F" : "#17201C"} stroke={sel ? "#17201C" : "#fff"} strokeWidth={3 / view.z} />
              <text x={x} y={y} dy="0.35em" textAnchor="middle" fontSize={15 / view.z} fontWeight={800} fill={sel ? "#17201C" : "#fff"}>
                {i + 1}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="absolute left-3 top-3 max-w-[calc(100%-80px)] rounded-control bg-white/95 px-3 py-2 text-xs shadow-control" role="status">
        <strong>Упрощённая карта.</strong> {props.reason}. Здания показаны плоско; результаты — в списке.
      </div>
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-2" role="group" aria-label="Управление картой">
        <MapControlButton label="Приблизить" onClick={() => zoomBy(1.5)}>
          +
        </MapControlButton>
        <MapControlButton label="Отдалить" onClick={() => zoomBy(1 / 1.5)}>
          −
        </MapControlButton>
        <MapControlButton label="Показать результаты" onClick={fit} testId="fit-results">
          <svg aria-hidden viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </svg>
        </MapControlButton>
      </div>
      <p className="absolute bottom-1 right-1 rounded bg-white/90 px-1.5 py-0.5 text-xs">
        <a className="underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
          © OpenStreetMap contributors
        </a>
      </p>
    </div>
  );
}
