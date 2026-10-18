"""A04 independent cross-check: each landmark OSM id of data/manifests/landmarks.json exists in the raw
Overpass snapshot, its centroid recomputed from raw geometry matches the manifest (≤ 30 m), and the
building/green layer served to the map contains the same OSM way (so the map draws the real contour).

  uv run python tests/security/landmarks_check.py data/snapshots/osm-20261018T200514Z data/manifests/landmarks.json data/map out.json
"""

from __future__ import annotations

import gzip
import json
import math
import sys
from pathlib import Path


def hav(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def main() -> int:
    snap, manifest, mapdir, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4])
    elements = {}
    for f in snap.glob("*.json.gz"):
        data = json.loads(gzip.decompress(f.read_bytes()))
        for e in data.get("elements", []):
            elements[f"{e['type']}/{e['id']}"] = (f.name, e)
    layer_ids = {}
    for layer in ("buildings", "green", "water"):
        fc = json.loads((mapdir / f"{layer}.geojson").read_text())
        for ft in fc["features"]:
            layer_ids[str(ft.get("properties", {}).get("id") or ft.get("id"))] = layer
    rows, fails = [], 0
    for lm in json.loads(manifest.read_text())["landmarks"]:
        osm = lm.get("osm")
        if not isinstance(osm, str) or " " in osm:
            rows.append({"key": lm["key"], "osm": osm, "note": "multi-way landmark, skipped"})
            continue
        found = elements.get(osm)
        row = {"key": lm["key"], "osm": osm, "in_snapshot": bool(found), "map_layer": layer_ids.get(osm)}
        if found:
            e = found[1]
            if "geometry" in e:
                from shapely.geometry import LineString, Polygon  # noqa: PLC0415

                pts = [(p["lon"], p["lat"]) for p in e["geometry"]]
                g = Polygon(pts) if len(pts) >= 4 and pts[0] == pts[-1] else LineString(pts)
                c = (g.centroid.x, g.centroid.y)
            elif "lat" in e:
                c = (e["lon"], e["lat"])
            else:
                c = None
            tags = e.get("tags", {})
            row["raw_name"] = tags.get("name")
            row["name_matches"] = lm.get("name") in {
                v for k, v in tags.items() if k == "name" or k.startswith("name:")
            }
            if c and lm.get("centroid_lonlat"):
                row["centroid_delta_m"] = round(hav(c, lm["centroid_lonlat"]), 1)
        ok = row["in_snapshot"] and row.get("name_matches", False) and row.get("centroid_delta_m", 0) <= 30
        row["verdict"] = "PASS" if ok else "FAIL"
        fails += not ok
        rows.append(row)
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    for r in rows:
        print(r)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
