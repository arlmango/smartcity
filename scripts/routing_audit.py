"""Audit public pilot paths against the source OSM highway geometry (not field access)."""

import json
import math
import time
import urllib.error
import urllib.request
from pathlib import Path

import osmium
from shapely.geometry import LineString, Point, Polygon
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts/routing-pilot"
ORIGIN = {"lat": 51.0889, "lon": 71.4152}
CONTROLS = {
    "alley": {"lat": 51.093889700000005, "lon": 71.41787097941943},
    "independence": {"lat": 51.0934498, "lon": 71.41756462521533},
    "mega": {"lat": 51.08908605, "lon": 71.40728592973313},
}


def decode(s):
    coords = []
    pos = 0
    lat = lon = 0
    while pos < len(s):
        deltas = []
        for _ in range(2):
            result = shift = 0
            while True:
                b = ord(s[pos]) - 63
                pos += 1
                result |= (b & 31) << shift
                shift += 5
                if b < 32:
                    break
            deltas.append(~(result >> 1) if result & 1 else result >> 1)
        lat += deltas[0]
        lon += deltas[1]
        coords.append([lon / 1e6, lat / 1e6])
    return coords


def xy(p):
    return ((p[0] - 71.4) * 111195 * math.cos(math.radians(51.1)), (p[1] - 51.1) * 111195)


class Roads(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.lines = []
        self.ids = []
        self.buildings = []

    def way(self, w):
        if (
            w.tags.get("building") not in (None, "roof")
            and len(w.nodes) > 3
            and w.nodes[0].ref == w.nodes[-1].ref
        ):
            polygon = Polygon([xy((n.lon, n.lat)) for n in w.nodes])
            if polygon.is_valid:
                self.buildings.append(polygon.buffer(-0.2))
        if w.tags.get("highway") and len(w.nodes) > 1:
            self.lines.append(LineString([xy((n.lon, n.lat)) for n in w.nodes]))
            self.ids.append(w.id)


r = Roads()
r.apply_file(str(ROOT / "data/routing/pilot/astana-pilot.osm.pbf"), locations=True)
tree = STRtree(r.lines)
buildings = STRtree(r.buildings)
results = []
features = []
for name, dest in CONTROLS.items():
    body = {
        "locations": [ORIGIN, dest, ORIGIN],
        "costing": "pedestrian",
        "costing_options": {"pedestrian": {"walking_speed": 4}},
        "units": "kilometers",
    }
    started = time.monotonic()
    req = urllib.request.Request(
        "http://127.0.0.1:8208/route", json.dumps(body).encode(), {"Content-Type": "application/json"}
    )
    raw = json.load(urllib.request.urlopen(req, timeout=5))  # noqa: S310 — fixed local endpoint
    elapsed = round((time.monotonic() - started) * 1000, 2)
    (OUT / f"raw-{name}.json").write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n")
    legs = []
    for i, leg in enumerate(raw["trip"]["legs"]):
        coords = decode(leg["shape"])
        line = LineString([xy(c) for c in coords])
        samples = [line.interpolate(d) for d in range(0, max(1, int(line.length)), 5)]
        nearest = tree.nearest(samples)
        deviations = [p.distance(r.lines[int(n)]) for p, n in zip(samples, nearest, strict=True)]
        gap_start = Point(
            xy((ORIGIN["lon"], ORIGIN["lat"]) if i == 0 else (dest["lon"], dest["lat"]))
        ).distance(Point(xy(coords[0])))
        gap_end = Point(
            xy((dest["lon"], dest["lat"]) if i == 0 else (ORIGIN["lon"], ORIGIN["lat"]))
        ).distance(Point(xy(coords[-1])))
        direct = LineString([xy(coords[0]), xy(coords[-1])])

        def crossed(path):
            return sum(path.intersection(r.buildings[int(j)]).length for j in buildings.query(path))

        metrics = {
            "direct_building_interior_m": round(crossed(direct), 2),
            "route_building_interior_m": round(crossed(line), 2),
            "leg": i,
            "distance_m": round(leg["summary"]["length"] * 1000),
            "seconds": leg["summary"]["time"],
            "shape_points": len(coords),
            "snap_start_m": round(gap_start, 2),
            "snap_end_m": round(gap_end, 2),
            "max_distance_to_osm_highway_m": round(max(deviations), 2),
            "osm_way_ids": sorted({r.ids[int(n)] for n in nearest}),
        }
        legs.append(metrics)
        features.append(
            {
                "type": "Feature",
                "properties": {"control": name, **metrics},
                "geometry": {"type": "LineString", "coordinates": coords},
            }
        )
    results.append({"control": name, "destination": dest, "request_ms": elapsed, "legs": legs})
(OUT / "control-lines.geojson").write_text(
    json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False) + "\n"
)
(OUT / "control-audit.json").write_text(
    json.dumps(
        {
            "origin": ORIGIN,
            "source": "local OSM PBF 2026-10-18",
            "note": (
                "Network geometry sampled every 5m; building interiors exclude building=roof "
                "(elevated canopy). Not physical access/entrance verification."
            ),
            "results": results,
        },
        ensure_ascii=False,
        indent=2,
    )
    + "\n"
)
print(json.dumps(results, ensure_ascii=False, indent=2))
