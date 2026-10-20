"use client";

import { useEffect, type RefObject } from "react";
import type { GeoJSONSource, Map as MlMap, Marker } from "maplibre-gl";
import { routeCoordinates, routeFeatures, type MapRoute } from "@/lib/walkingRoute";

/** Reinstalls route layers after a style change; cleanup removes all stale geometry/markers. */
export function useWalkingRoute(
  mapRef: RefObject<MlMap | null>,
  libRef: RefObject<typeof import("maplibre-gl") | null>,
  loaded: boolean,
  route: MapRoute | null,
  reducedMotion: boolean,
) {
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib || !loaded) return;
    let frame = 0;
    const markers: Marker[] = [];
    const draw = () => {
      if (!map.isStyleLoaded()) {
        map.once("idle", draw);
        return;
      }
      const fc = routeFeatures(route);
      if (!map.getSource("walking-route")) map.addSource("walking-route", { type: "geojson", data: fc });
      else (map.getSource("walking-route") as GeoJSONSource).setData(fc);
      if (!map.getLayer("walking-outbound")) {
        map.addLayer({ id: "walking-outbound", type: "line", source: "walking-route", filter: ["==", "leg", "outbound"],
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#176447", "line-width": 6, "line-opacity": reducedMotion ? 1 : 0,
            "line-opacity-transition": { duration: reducedMotion ? 0 : 450 } } });
        map.addLayer({ id: "walking-return", type: "line", source: "walking-route", filter: ["==", "leg", "return"],
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#7043A0", "line-width": 3, "line-dasharray": [2, 2], "line-opacity": reducedMotion ? 1 : 0,
            "line-opacity-transition": { duration: reducedMotion ? 0 : 450 } } });
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (map.getLayer("walking-outbound")) map.setPaintProperty("walking-outbound", "line-opacity", 1);
        if (map.getLayer("walking-return")) map.setPaintProperty("walking-return", "line-opacity", 1);
      });
    };
    draw();
    map.on("style.load", draw);
    if (route) {
      route.marks.forEach(({ label, point, letter }) => {
        const el = document.createElement("div");
        // Plan stops replace the result markers on the map, so they are as prominent as those.
        el.className = route.kind === "plan"
          ? "grid h-9 w-9 place-items-center rounded-full border-2 border-white bg-[#176447] text-sm font-extrabold text-white shadow-control"
          : "rounded-full border-2 border-white bg-[#176447] px-1.5 text-xs font-bold text-white shadow-control";
        el.textContent = letter;
        el.setAttribute("role", "img");
        el.setAttribute("aria-label", label);
        el.setAttribute("data-testid", route.kind === "plan" ? "plan-stop-mark" : "route-endpoint");
        markers.push(new lib.Marker({ element: el }).setLngLat(point).addTo(map));
      });
      const coordinates = routeCoordinates(route);
      const bounds = new lib.LngLatBounds(coordinates[0], coordinates[0]);
      coordinates.forEach((p) => bounds.extend(p));
      map.fitBounds(bounds, { padding: { top: 110, bottom: 70, left: 50, right: 75 }, maxZoom: 17,
        duration: reducedMotion ? 0 : 900, essential: false });
    }
    return () => {
      cancelAnimationFrame(frame);
      map.off("style.load", draw);
      map.off("idle", draw);
      markers.forEach((marker) => marker.remove());
      if (map.getSource("walking-route")) (map.getSource("walking-route") as GeoJSONSource).setData(routeFeatures(null));
    };
  }, [mapRef, libRef, loaded, route, reducedMotion]);
}
