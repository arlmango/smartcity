"""SYNTHETIC vector tiles for the deterministic browser E2E tests (apps/web/tests/fixtures/tiles).

Not real data: invented geometry around the EXPO test fixture area, served by the E2E API mock in
place of /api/tiles/{base,buildings}/{z}/{x}/{y}. Uses the same layer schema as the real tiles
(Protomaps basemap layers; SmartCity `buildings` fields, docs/CONTRACTS.md §7a).

Usage: uv run python scripts/make_e2e_tiles.py
"""

from __future__ import annotations

import math
import shutil
from pathlib import Path

import mapbox_vector_tile
from shapely.geometry import LineString, Point, Polygon, box
from smartcity_ingest.vtiles import merc, tile_bounds, tile_range

OUT = Path(__file__).resolve().parents[1] / "apps" / "web" / "tests" / "fixtures" / "tiles"
C = (71.414, 51.089)
AREA = (71.38, 51.07, 71.45, 51.11)
EXTENT = 4096


def rect(cx: float, cy: float, w_m: float, h_m: float) -> Polygon:
    k = 111_320 * math.cos(math.radians(cy))
    return box(cx - w_m / 2 / k, cy - h_m / 2 / 110_540, cx + w_m / 2 / k, cy + h_m / 2 / 110_540)


def base_features() -> dict[str, list[tuple]]:
    return {
        "earth": [(box(*AREA).buffer(0.05), {"kind": "earth"})],
        "landuse": [
            (rect(C[0] + 0.004, C[1] + 0.003, 260, 180), {"kind": "park", "sort_rank": 1}),
            (rect(C[0] - 0.008, C[1] - 0.006, 400, 300), {"kind": "residential", "sort_rank": 1}),
        ],
        "water": [(Point(71.4042, 51.094).buffer(0.0009), {"kind": "water", "sort_rank": 1})],
        "roads": [
            (
                LineString([(71.38, C[1]), (71.45, C[1])]),
                {"kind": "major_road", "kind_detail": "primary", "name": "проспект SYNTH", "sort_rank": 3},
            ),
            (
                LineString([(C[0], 51.07), (C[0], 51.11)]),
                {"kind": "minor_road", "kind_detail": "residential", "name": "улица SYNTH", "sort_rank": 2},
            ),
            (LineString([(71.40, 51.08), (71.43, 51.10)]), {"kind": "path", "kind_detail": "footway"}),
        ],
        "pois": [(Point(C[0] + 0.004, C[1] + 0.003), {"kind": "park", "name": "Сквер SYNTH"})],
        "places": [(Point(C[0] - 0.01, C[1] + 0.012), {"kind": "neighbourhood", "name": "SYNTH-квартал"})],
    }


def building_features() -> list[tuple]:
    feats: list[tuple] = []
    srcs = [("height", 30.0), ("levels", 16.0), ("estimate", 6.0), ("default", 10.0)]
    n = 0
    for i in range(6):
        for j in range(5):
            src, h = srcs[n % 4]
            g = rect(C[0] - 0.006 + i * 0.0022, C[1] - 0.004 + j * 0.0016, 40, 30)
            props = {"h": h, "mh": 0.0, "src": src, "kind": "yes"}
            if src == "estimate":
                props["eb"] = "area"
            feats.append((g, props, 9000 + n))
            n += 1
    # A hipped roof approximated by slices (as roofs.py would emit).
    g = rect(C[0] + 0.009, C[1] - 0.003, 30, 20)
    house = {"h": 7.0, "mh": 0.0, "src": "height", "kind": "house", "roofed": 1, "roof": "hipped"}
    feats.append((g, house, 9900))
    for k in range(3):
        inner = rect(C[0] + 0.009, C[1] - 0.003, 30 - 8 * k, 20 - 6 * k)
        roof = {"h": 7.0 + k + 1, "mh": 7.0 + k, "src": "height", "kind": "house", "rs": 1}
        feats.append((inner, roof, 9900))
    # A stylised sphere with its label slice.
    for k in range(6):
        t = (k + 0.5) / 6 * 2 - 1
        r = 40 * math.sqrt(1 - t * t)
        props = {"h": 20 + (k + 1) * 13.3, "mh": 20 + k * 13.3, "src": "height", "kind": "yes"}
        props |= {"rs": 1, "styl": 1}
        if k == 3:
            props["lbl"] = "SYNTH-сфера · стилизация"
        feats.append((Point(C[0] + 0.002, C[1] + 0.0004).buffer(r / 70_000, 24), props, 9950))
    return feats


def encode(layers: dict[str, list[tuple]], z: int, x: int, y: int) -> bytes | None:
    minx, miny, maxx, maxy = tile_bounds(z, x, y)
    pad = 64 * (maxx - minx) / EXTENT
    clip = box(minx - pad, miny - pad, maxx + pad, maxy + pad)
    out = []
    for name, feats in layers.items():
        enc = []
        for f in feats:
            g = merc(f[0]).intersection(clip)
            if g.is_empty:
                continue
            item = {"geometry": g, "properties": f[1]}
            if len(f) > 2:
                item["id"] = f[2]
            enc.append(item)
        if enc:
            out.append({"name": name, "features": enc})
    if not out:
        return None
    return mapbox_vector_tile.encode(
        out, default_options={"quantize_bounds": (minx, miny, maxx, maxy), "extents": EXTENT}
    )


def main() -> None:
    shutil.rmtree(OUT, ignore_errors=True)
    area_m = merc(box(*AREA)).bounds
    n = 0
    for tileset, zooms, layers in (
        ("base", range(10, 16), base_features()),
        ("buildings", range(13, 16), {"buildings": building_features()}),
    ):
        for z in zooms:
            for x, y in tile_range(area_m, z):
                data = encode(layers, z, x, y)
                if data:
                    p = OUT / tileset / str(z) / str(x) / f"{y}.pbf"
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_bytes(data)
                    n += 1
    (OUT / "README.md").write_text(
        "SYNTHETIC vector tiles for E2E tests only (scripts/make_e2e_tiles.py). Not real data.\n",
        encoding="utf-8",
    )
    print(f"{n} synthetic tiles -> {OUT}")


if __name__ == "__main__":
    main()
