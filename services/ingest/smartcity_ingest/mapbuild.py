"""GeoJSON map layers (CONTRACTS §7) from the snapshot: buildings, roads, water, green, coverage.

Buildings are never simplified and are kept whole when they intersect the coverage; roads,
water and green are clipped to the coverage. Coordinates are [lon, lat] rounded to 6 decimals.
Roads/green are simplified (tolerance <= 1 m) only if the total size exceeds the budget.
"""

from __future__ import annotations

import json
import logging
import math
import re
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

from shapely.geometry import LineString, MultiLineString, mapping
from shapely.geometry.base import BaseGeometry
from shapely.prepared import prep

from smartcity_ingest.geometry import element_geometry, polygonal, round_coords, way_geometry
from smartcity_ingest.paths import CoverageArea
from smartcity_ingest.snapshot import Snapshot, sha256_file

log = logging.getLogger("smartcity_ingest.mapbuild")

LEVEL_HEIGHT_M = 3.2
DEFAULT_HEIGHT_M = 10.0
# Documented estimates (docs/DATA.md "Высоты зданий") for buildings without height / building:levels.
# They are never presented as measurements: height_source = "estimate", estimate_basis = type | area.
SMALL_TYPE_HEIGHT_M = 3.0
HOUSE_TYPE_HEIGHT_M = 6.0
LOW_LARGE_TYPE_HEIGHT_M = 8.0
TYPE_HEIGHT_M: dict[str, float] = {
    **dict.fromkeys(
        (
            "garage", "garages", "carport", "shed", "hut", "kiosk", "toilets", "greenhouse", "guardhouse",
            "service", "cabin", "static_caravan", "bunker", "construction", "container", "allotment_house",
        ),
        SMALL_TYPE_HEIGHT_M,
    ),
    **dict.fromkeys(
        ("house", "detached", "semidetached_house", "terrace", "bungalow", "farm", "barn", "stable"),
        HOUSE_TYPE_HEIGHT_M,
    ),
    **dict.fromkeys(
        ("industrial", "warehouse", "hangar", "retail", "supermarket", "roof", "grandstand", "pavilion",
         "sports_hall", "manufacture", "storage_tank"),
        LOW_LARGE_TYPE_HEIGHT_M,
    ),
}  # fmt: skip
# building=yes (type unknown): footprint size class. < 40 m² — shed/garage size, < 250 m² — house size.
AREA_SMALL_M2 = 40.0
AREA_HOUSE_M2 = 250.0
SIZE_BUDGET_BYTES = 15 * 1024 * 1024
SIMPLIFY_TOLERANCE_DEG = 8e-6  # ~0.9 m in latitude, ~0.56 m in longitude at 51°N
EXCLUDED_HIGHWAYS = {"proposed", "abandoned", "razed", "disused", "platform", "bus_stop", "elevator"}
LAYERS = ("buildings", "roads", "water", "green", "coverage")

_NUM = re.compile(r"^\s*(\d+(?:[.,]\d+)?)\s*(m|м|meters?|metres?)?\s*$", re.I)


def parse_height(value: str | None) -> float | None:
    if value is None:
        return None
    m = _NUM.match(str(value))
    if not m:
        return None
    v = float(m.group(1).replace(",", "."))
    return v if 0 < v < 1000 else None


def parse_levels(value: str | None) -> float | None:
    if value is None:
        return None
    m = re.match(r"^\s*(\d+(?:[.,]\d+)?)\s*$", str(value))
    if not m:
        return None
    v = float(m.group(1).replace(",", "."))
    return v if 0 <= v < 300 else None


def estimated_height(tags: dict, area_m2: float | None) -> tuple[float, str] | None:
    """Documented estimate by building type, else by footprint size for building=yes; None = no basis."""
    kind = (tags.get("building") or tags.get("building:part") or "yes").strip().lower()
    if kind in TYPE_HEIGHT_M:
        return TYPE_HEIGHT_M[kind], "type"
    # Footprint size says nothing about a building:part (a small part of a tall tower): type only.
    if kind == "yes" and area_m2 is not None and "building" in tags:
        if area_m2 < AREA_SMALL_M2:
            return SMALL_TYPE_HEIGHT_M, "area"
        if area_m2 < AREA_HOUSE_M2:
            return HOUSE_TYPE_HEIGHT_M, "area"
    return None


def building_heights(tags: dict, area_m2: float | None = None) -> dict:
    """Priority: height (m) -> building:levels x 3.2 m -> documented estimate (type / footprint size) ->
    explicit 10 m default. min_height similarly -> 0."""
    h = parse_height(tags.get("height"))
    levels = parse_levels(tags.get("building:levels"))
    basis = None
    if h is not None:
        height, src = h, "height"
    elif levels is not None and levels > 0:
        height, src = round(levels * LEVEL_HEIGHT_M, 2), "levels"
    elif (est := estimated_height(tags, area_m2)) is not None:
        (height, basis), src = est, "estimate"
    else:
        height, src = DEFAULT_HEIGHT_M, "default"
    mh = parse_height(tags.get("min_height"))
    min_level = parse_levels(tags.get("building:min_level"))
    if mh is not None:
        min_h = mh
    elif min_level is not None:
        min_h = round(min_level * LEVEL_HEIGHT_M, 2)
    else:
        min_h = 0.0
    out = {"height_m": height, "min_height_m": min_h, "height_source": src}
    if basis:
        out["estimate_basis"] = basis
    if levels is not None:
        out["levels"] = levels if levels != int(levels) else int(levels)
    if min_h >= height:
        # Inconsistent tagging: do not invent a value, fall back to ground level and flag it.
        out["min_height_m"] = 0.0
        out["min_height_note"] = "min_height >= height in OSM; using 0"
    return out


def area_m2_lonlat(g: BaseGeometry) -> float:
    """Approximate area (m²) of a small lon/lat polygon (local equirectangular scale)."""
    lat = g.centroid.y
    return g.area * 111_320.0 * math.cos(math.radians(lat)) * 110_540.0


def _feature(geom: BaseGeometry, props: dict) -> dict:
    return {"type": "Feature", "geometry": mapping(geom), "properties": props}


def _rounded(geom: BaseGeometry) -> BaseGeometry | None:
    g = round_coords(geom, 6)
    if g.is_empty:
        return None
    return g


def _lines(geom: BaseGeometry) -> list[LineString]:
    if isinstance(geom, LineString):
        return [geom] if not geom.is_empty else []
    if isinstance(geom, MultiLineString):
        return [g for g in geom.geoms if not g.is_empty]
    if hasattr(geom, "geoms"):
        out: list[LineString] = []
        for g in geom.geoms:
            out.extend(_lines(g))
        return out
    return []


def build_buildings(elements: list[dict], cov: BaseGeometry, stats: dict) -> list[dict]:
    pc = prep(cov)
    feats = []
    seen = set()
    for el in elements:
        tags = el.get("tags") or {}
        if "building" not in tags or tags.get("building") == "no":
            continue
        ref = f"{el['type']}/{el['id']}"
        if ref in seen:
            continue
        seen.add(ref)
        g = element_geometry(el)
        g = polygonal(g) if g is not None else None
        if g is None:
            stats["buildings_skipped_no_polygon"] += 1
            continue
        if not pc.intersects(g):
            continue
        g = _rounded(g)
        g = polygonal(g) if g is not None else None
        if g is None or not g.is_valid:
            stats["buildings_skipped_invalid"] += 1
            continue
        if (
            g.geom_type == "Polygon"
            and len(g.interiors)
            or (g.geom_type == "MultiPolygon" and any(len(p.interiors) for p in g.geoms))
        ):
            stats["buildings_with_holes"] += 1
        props: dict = {"id": ref, "building": tags["building"]}
        name = tags.get("name:ru") or tags.get("name")
        if name:
            props["name"] = name
        props.update(building_heights(tags, area_m2_lonlat(g)))
        stats[f"height_source_{props['height_source']}"] += 1
        feats.append(_feature(g, props))
    return feats


def build_roads(elements: list[dict], cov: BaseGeometry, stats: dict, simplify: bool) -> list[dict]:
    pc = prep(cov)
    feats = []
    for el in elements:
        tags = el.get("tags") or {}
        hw = tags.get("highway")
        if el.get("type") != "way" or not hw or hw in EXCLUDED_HIGHWAYS:
            continue
        g = way_geometry(el, force_line=True)
        if g is None or not pc.intersects(g):
            continue
        clipped = g if pc.contains(g) else g.intersection(cov)
        if simplify:
            clipped = clipped.simplify(SIMPLIFY_TOLERANCE_DEG, preserve_topology=True)
        parts = _lines(clipped)
        for i, part in enumerate(parts):
            r = _rounded(part)
            if r is None or r.length == 0:
                continue
            props: dict = {"id": f"way/{el['id']}", "highway": hw}
            name = tags.get("name:ru") or tags.get("name")
            if name:
                props["name"] = name
            if len(parts) > 1:
                props["part"] = i
            feats.append(_feature(r, props))
    return feats


def _polys_clipped(g: BaseGeometry, cov: BaseGeometry, pc) -> BaseGeometry | None:
    if not pc.intersects(g):
        return None
    clipped = g if pc.contains(g) else polygonal(g.intersection(cov))
    if clipped is None:
        return None
    r = _rounded(clipped)
    return polygonal(r) if r is not None else None


def build_water(elements: list[dict], cov: BaseGeometry, stats: dict) -> list[dict]:
    pc = prep(cov)
    feats = []
    seen = set()
    for el in elements:
        ref = f"{el['type']}/{el['id']}"
        if ref in seen:
            continue
        seen.add(ref)
        tags = el.get("tags") or {}
        name = tags.get("name:ru") or tags.get("name")
        if tags.get("waterway") and tags.get("waterway") != "riverbank" and el["type"] == "way":
            g = way_geometry(el, force_line=True)
            if g is None or not pc.intersects(g):
                continue
            for part in _lines(g.intersection(cov)):
                r = _rounded(part)
                if r is not None and r.length > 0:
                    props = {"id": ref, "kind": tags["waterway"]}
                    if name:
                        props["name"] = name
                    feats.append(_feature(r, props))
            continue
        g = element_geometry(el)
        g = polygonal(g) if g is not None else None
        if g is None:
            continue
        clipped = _polys_clipped(g, cov, pc)
        if clipped is None:
            continue
        kind = (
            tags.get("water") or tags.get("natural") or tags.get("landuse") or tags.get("leisure") or "water"
        )
        if tags.get("waterway") == "riverbank":
            kind = "river"
        props = {"id": ref, "kind": kind}
        if name:
            props["name"] = name
        feats.append(_feature(clipped, props))
    return feats


def build_green(elements: list[dict], cov: BaseGeometry, stats: dict, simplify: bool) -> list[dict]:
    pc = prep(cov)
    feats = []
    seen = set()
    for el in elements:
        ref = f"{el['type']}/{el['id']}"
        if ref in seen:
            continue
        seen.add(ref)
        tags = el.get("tags") or {}
        g = element_geometry(el)
        g = polygonal(g) if g is not None else None
        if g is None:
            continue
        if simplify:
            g = polygonal(g.simplify(SIMPLIFY_TOLERANCE_DEG, preserve_topology=True))
            if g is None:
                continue
        clipped = _polys_clipped(g, cov, pc)
        if clipped is None:
            continue
        kind = tags.get("leisure") or tags.get("landuse") or tags.get("natural")
        props = {"id": ref, "kind": kind}
        name = tags.get("name:ru") or tags.get("name")
        if name:
            props["name"] = name
        feats.append(_feature(clipped, props))
    return feats


def _fc(feats: list[dict], snapshot: Snapshot) -> dict:
    return {
        "type": "FeatureCollection",
        "metadata": {
            "dataset_version": snapshot.dataset_version,
            "osm_base_timestamp": snapshot.manifest.get("osm_base_timestamp"),
            "license": "ODbL-1.0",
            "attribution": "© OpenStreetMap contributors",
        },
        "features": feats,
    }


def _dump(path: Path, obj: dict) -> int:
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


def build_map(snapshot: Snapshot, coverage: CoverageArea, out_dir: Path) -> dict:
    required = ("map_buildings", "map_roads", "map_water", "map_green")
    missing = [g for g in required if not snapshot.group_ok(g)]
    if missing:
        raise RuntimeError(f"map groups missing in snapshot: {missing}; map not rebuilt")
    out_dir.mkdir(parents=True, exist_ok=True)
    cov = coverage.geometry
    stats: Counter = Counter()

    def layers(simplify: bool) -> dict[str, list[dict]]:
        return {
            "buildings": build_buildings(snapshot.elements("map_buildings"), cov, stats),
            "roads": build_roads(snapshot.elements("map_roads"), cov, stats, simplify),
            "water": build_water(snapshot.elements("map_water"), cov, stats),
            "green": build_green(snapshot.elements("map_green"), cov, stats, simplify),
            "coverage": [
                _feature(
                    cov,
                    {
                        "id": coverage.id,
                        "name": coverage.name,
                        "dataset_version": snapshot.dataset_version,
                        "osm_base_timestamp": snapshot.manifest.get("osm_base_timestamp"),
                    },
                )
            ],
        }

    simplified = False
    data = layers(False)
    sizes = {
        k: len(json.dumps(_fc(v, snapshot), ensure_ascii=False, separators=(",", ":")).encode())
        for k, v in data.items()
    }
    if sum(sizes.values()) > SIZE_BUDGET_BYTES:
        stats.clear()
        data = layers(True)
        simplified = True

    files = {}
    for name, feats in data.items():
        p = out_dir / f"{name}.geojson"
        size = _dump(p, _fc(feats, snapshot))
        files[name] = {"file": p.name, "features": len(feats), "bytes": size, "sha256": sha256_file(p)}

    manifest = {
        "dataset_version": snapshot.dataset_version,
        "osm_base_timestamp": snapshot.manifest.get("osm_base_timestamp"),
        "snapshot_hash": snapshot.snapshot_hash,
        "built_at": datetime.now(UTC).isoformat(),
        "coverage_id": coverage.id,
        "coordinate_order": "[lon, lat]",
        "coordinate_precision_decimals": 6,
        "layers": files,
        "counts": {k: v["features"] for k, v in files.items()},
        "total_bytes": sum(v["bytes"] for v in files.values()),
        "simplification": {
            "applied": simplified,
            "layers": ["roads", "green"] if simplified else [],
            "tolerance_deg": SIMPLIFY_TOLERANCE_DEG if simplified else None,
            "note": "Buildings are never simplified.",
        },
        "buildings": {
            "height_rule": "height (m) -> building:levels x 3.2 m -> 10 m default (approximate)",
            "min_height_rule": "min_height -> building:min_level x 3.2 m -> 0",
            "height_provenance": {
                "height": stats["height_source_height"],
                "levels": stats["height_source_levels"],
                "estimate": stats["height_source_estimate"],
                "default": stats["height_source_default"],
            },
            "with_inner_rings": stats["buildings_with_holes"],
            "skipped_no_polygon": stats["buildings_skipped_no_polygon"],
            "skipped_invalid": stats["buildings_skipped_invalid"],
            "clip": "kept whole when intersecting coverage",
        },
        "clip": "roads/water/green clipped to coverage polygon",
        "license": "ODbL-1.0",
        "attribution": "© OpenStreetMap contributors",
        "attribution_url": "https://www.openstreetmap.org/copyright",
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return manifest
