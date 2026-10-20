"""City-wide building vector tiles (MVT in PMTiles) from a Geofabrik OSM extract.

The base map of the whole city (roads, water, landuse, labels) comes from a Protomaps
extract; its buildings carry no height source, so SmartCity builds its own `buildings`
layer: every OSM building / building:part inside the bbox with height, min_height and
`src` (height | levels | estimate | default) from mapbuild.building_heights; tagged roof shapes are
approximated by roofs.py. Field reference: docs/CONTRACTS.md §7a.
"""

from __future__ import annotations

import gzip
import json
import logging
import math
import re
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import mapbox_vector_tile
import numpy as np
import shapely
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer
from shapely.geometry.base import BaseGeometry

from smartcity_ingest import roofs
from smartcity_ingest.geometry import polygonal
from smartcity_ingest.mapbuild import area_m2_lonlat, building_heights

log = logging.getLogger("smartcity_ingest.vtiles")

R = 6378137.0
HALF = math.pi * R
EXTENT = 4096
BUFFER_PX = 64
MIN_ZOOM = 13
MAX_ZOOM = 15
LAYER = "buildings"
_HEX = re.compile(r"^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
# CSS colour names that actually occur in OSM building:colour / roof:colour; others are dropped.
_NAMED = {
    "white": "#ffffff",
    "black": "#000000",
    "grey": "#808080",
    "gray": "#808080",
    "lightgrey": "#d3d3d3",
    "lightgray": "#d3d3d3",
    "darkgrey": "#a9a9a9",
    "darkgray": "#a9a9a9",
    "dimgray": "#696969",
    "dimgrey": "#696969",
    "silver": "#c0c0c0",
    "red": "#ff0000",
    "darkred": "#8b0000",
    "maroon": "#800000",
    "brown": "#a52a2a",
    "orange": "#ffa500",
    "yellow": "#ffff00",
    "beige": "#f5f5dc",
    "tan": "#d2b48c",
    "green": "#008000",
    "darkgreen": "#006400",
    "olive": "#808000",
    "blue": "#0000ff",
    "navy": "#000080",
    "lightblue": "#add8e6",
    "skyblue": "#87ceeb",
    "teal": "#008080",
    "turquoise": "#40e0d0",
    "gold": "#ffd700",
    "pink": "#ffc0cb",
    "purple": "#800080",
    "cream": "#fffdd0",
    "ivory": "#fffff0",
}
# Tagged colours are softened toward the map's neutral building tone, so a facade keeps its hue
# (blue glass, sandstone, brick) without saturated CSS colours dominating the scene.
_NEUTRAL = (0xE6, 0xE4, 0xDD)
WALL_MIX = 0.55
ROOF_MIX = 0.5


@dataclass
class Building:
    fid: int  # osmium area id: way_id*2 or relation_id*2+1
    geom: BaseGeometry  # Web Mercator metres
    props: dict


def merc(geom: BaseGeometry) -> BaseGeometry:
    def f(xy):
        lon, lat = xy[:, 0], xy[:, 1].clip(-85.0511, 85.0511)
        return np.column_stack([R * np.radians(lon), R * np.log(np.tan(math.pi / 4 + np.radians(lat) / 2))])

    return shapely.transform(geom, f)


def colour(value: str | None, mix: float = WALL_MIX) -> str | None:
    """Normalised, softened #rrggbb for an OSM colour value; None if it is not a known colour."""
    if not value:
        return None
    v = value.strip().lower()
    v = _NAMED.get(v, v)
    m = _HEX.match(v)
    if not m:
        return None
    h = m.group(1)
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    rgb = [int(h[i : i + 2], 16) for i in (0, 2, 4)]
    out = [round(c * (1 - mix) + n * mix) for c, n in zip(rgb, _NEUTRAL, strict=True)]
    return "#" + "".join(f"{c:02x}" for c in out)


def building_props(tags: dict, is_part: bool, area_m2: float | None = None) -> dict:
    h = building_heights(tags, area_m2)
    props: dict = {"h": h["height_m"], "mh": h["min_height_m"], "src": h["height_source"]}
    if "estimate_basis" in h:
        props["eb"] = h["estimate_basis"]
    if "levels" in h:
        props["lv"] = h["levels"]
    kind = tags.get("building:part") if is_part else tags.get("building")
    props["kind"] = (kind or "yes")[:32]
    if is_part:
        props["part"] = 1
    for key, out, mix in (("building:colour", "col", WALL_MIX), ("roof:colour", "rcol", ROOF_MIX)):
        c = colour(tags.get(key), mix)
        if c:
            props[out] = c
    if tags.get("roof:shape"):
        props["roof"] = tags["roof:shape"][:24]
    return props


def extract_buildings(
    pbf: Path,
    bbox: tuple[float, float, float, float],
    stats: Counter,
    landmarks: list[roofs.LandmarkShape] | None = None,
) -> tuple[list[Building], list[dict]]:
    """All building / building:part areas whose envelope intersects bbox (lon/lat), with roof shapes
    approximated and checked landmark stylisations applied; also returns the landmark check results."""
    import osmium

    wkb = osmium.geom.WKBFactory()
    minx, miny, maxx, maxy = bbox
    out: list[Building] = []
    roof_tags: dict[int, float] = {}
    landmarks = landmarks or []
    watch = {lm.area_id for lm in landmarks} | {lm.parent_area_id for lm in landmarks if lm.parent_area_id}
    watched: dict[int, tuple[BaseGeometry, dict]] = {}
    keys = osmium.filter.KeyFilter("building", "building:part")
    fp = osmium.FileProcessor(str(pbf)).with_areas(keys).with_filter(keys)
    for obj in fp:
        if not isinstance(obj, osmium.osm.Area):
            continue
        tags = {t.k: t.v for t in obj.tags}
        is_part = "building:part" in tags and "building" not in tags
        if tags.get("building", "") == "no" or tags.get("building:part", "") == "no":
            continue
        try:
            g = shapely.from_wkb(wkb.create_multipolygon(obj))
        except Exception:  # noqa: BLE001 - broken multipolygons are counted, not fatal
            stats["invalid_area"] += 1
            continue
        x0, y0, x1, y1 = g.bounds
        if x1 < minx or x0 > maxx or y1 < miny or y0 > maxy:
            continue
        if not g.is_valid:
            stats["made_valid"] += 1
        g = polygonal(g)  # make_valid may yield a GeometryCollection: keep only Polygon/MultiPolygon
        if g is None:
            stats["invalid_area"] += 1
            continue
        props = building_props(tags, is_part, area_m2_lonlat(g))
        fid = int(obj.id)
        # OSM object of the area (osmium: way id × 2, relation id × 2 + 1), so the map can hide an
        # object that a landmark model replaces.
        props["oid"] = f"w{fid // 2}" if fid % 2 == 0 else f"r{fid // 2}"
        if fid in watch:
            watched[fid] = (g, tags)
        rh = roofs._parse_m(tags.get("roof:height"))
        if rh is not None:
            roof_tags[fid] = rh
        stats["parts" if is_part else "buildings"] += 1
        if not is_part:
            stats[f"src_{props['src']}"] += 1
            if "eb" in props:
                stats[f"estimate_{props['eb']}"] += 1
        out.append(Building(fid=fid, geom=merc(g), props=props))
    _mark_outlines_with_parts(out, stats)
    applied, results = _apply_landmarks(landmarks, watched)
    return _expand_roofs(out, roof_tags, applied, stats), results


def _apply_landmarks(
    landmarks: list[roofs.LandmarkShape],
    watched: dict[int, tuple[BaseGeometry, dict]],
) -> tuple[dict[int, roofs.LandmarkShape], list[dict]]:
    applied: dict[int, roofs.LandmarkShape] = {}
    results = []
    for lm in landmarks:
        if lm.area_id not in watched:
            results.append({"osm": lm.osm, "applied": False, "problems": ["element not found in extract"]})
            continue
        geom, _ = watched[lm.area_id]
        parent = watched.get(lm.parent_area_id) if lm.parent_area_id else None
        pgeom, ptags = parent if parent else (None, None)
        problems = roofs.verify_landmark(lm, geom, pgeom, ptags)
        if problems:
            log.warning("landmark %s not stylised: %s", lm.osm, "; ".join(problems))
        else:
            applied[lm.area_id] = lm
        c = geom.centroid
        results.append(
            {
                "osm": lm.osm,
                "shape": lm.shape,
                "applied": not problems,
                "problems": problems,
                "centroid": [round(c.x, 6), round(c.y, 6)],
                "circularity": round(roofs.circularity(geom), 3),
            }
        )
    return applied, results


def _expand_roofs(
    items: list[Building],
    roof_tags: dict[int, float],
    applied: dict[int, roofs.LandmarkShape],
    stats: Counter,
) -> list[Building]:
    out: list[Building] = []
    for b in items:
        lat = math.degrees(2 * math.atan(math.exp(b.geom.centroid.y / R)) - math.pi / 2)
        scale = math.cos(math.radians(lat))  # true metres per Web Mercator metre
        lm = applied.get(b.fid)
        if lm is not None:
            props = {**b.props, "styl": 1}
            pieces = roofs.sphere_on_stem(b.geom, props, scale)
            mid = pieces[len(pieces) // 2]
            mid.props["lbl"] = lm.label
            stats["roofs_landmark"] += 1
            kind: str | None = "landmark"
        else:
            pieces, kind = roofs.slice_roof(b.geom, b.props, roof_tags.get(b.fid), scale)
        if kind and kind != "landmark":
            stats[f"roofs_{kind}"] += 1
        out.extend(Building(fid=b.fid, geom=p.geom, props=p.props) for p in pieces)
    return out


def extract_boundary(pbf: Path, relation_id: int) -> BaseGeometry | None:
    """Administrative boundary polygon (lon/lat) of one OSM relation."""
    import osmium

    wkb = osmium.geom.WKBFactory()
    flt = osmium.filter.IdFilter([relation_id])
    for obj in osmium.FileProcessor(str(pbf)).with_areas(flt):
        if isinstance(obj, osmium.osm.Area) and not obj.from_way() and obj.orig_id() == relation_id:
            return shapely.from_wkb(wkb.create_multipolygon(obj))
    return None


def _mark_outlines_with_parts(items: list[Building], stats: Counter) -> None:
    """Simple-3D-Buildings: an outline whose building:parts reach the ground is drawn by its parts in 3D.

    If every contained part is elevated (e.g. Bayterek: only the orb is a part, the shaft is the
    outline itself), the outline stays visible and supports the parts.
    """
    parts = [b for b in items if b.props.get("part")]
    if not parts:
        return
    tree = shapely.STRtree([shapely.point_on_surface(p.geom) for p in parts])
    for b in items:
        if b.props.get("part"):
            continue
        idx = tree.query(b.geom, predicate="contains")
        if len(idx) and any(parts[i].props["mh"] < 2 for i in idx):
            b.props["has_parts"] = 1
            stats["outlines_with_parts"] += 1
        elif len(idx):
            stats["outlines_kept_elevated_parts"] += 1


def tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    size = 2 * HALF / 2**z
    minx = -HALF + x * size
    maxy = HALF - y * size
    return minx, maxy - size, minx + size, maxy


def tile_range(bbox_merc: tuple[float, float, float, float], z: int) -> Iterator[tuple[int, int]]:
    size = 2 * HALF / 2**z
    x0 = int((bbox_merc[0] + HALF) // size)
    x1 = int((bbox_merc[2] + HALF) // size)
    y0 = int((HALF - bbox_merc[3]) // size)
    y1 = int((HALF - bbox_merc[1]) // size)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            yield x, y


def encode_tile(items: list[Building], z: int, x: int, y: int) -> bytes | None:
    minx, miny, maxx, maxy = tile_bounds(z, x, y)
    px = (maxx - minx) / EXTENT
    buf = BUFFER_PX * px
    feats = []
    for b in items:
        g = b.geom
        if z < MAX_ZOOM:
            if g.area < (2 * px) ** 2:  # sub-pixel buildings only at overview zooms
                continue
            g = g.simplify(px * 0.5, preserve_topology=True)
        g = polygonal(shapely.clip_by_rect(g, minx - buf, miny - buf, maxx + buf, maxy + buf))
        if g is None or g.area == 0:
            continue
        feats.append({"geometry": g, "properties": b.props, "id": b.fid})
    if not feats:
        return None
    return mapbox_vector_tile.encode(
        [{"name": LAYER, "features": feats}],
        default_options={"quantize_bounds": (minx, miny, maxx, maxy), "extents": EXTENT},
    )


def write_pmtiles(items: list[Building], bbox: tuple[float, float, float, float], out: Path) -> dict:
    """Tile z13..z15 into a clustered PMTiles archive; returns tile statistics."""
    mb = merc(shapely.box(*bbox)).bounds
    tree = shapely.STRtree([b.geom for b in items])
    tiles: dict[int, bytes] = {}
    per_zoom: Counter = Counter()
    for z in range(MIN_ZOOM, MAX_ZOOM + 1):
        for x, y in tile_range(mb, z):
            b = tile_bounds(z, x, y)
            pad = BUFFER_PX * (b[2] - b[0]) / EXTENT
            idx = tree.query(shapely.box(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad))
            if len(idx) == 0:
                continue
            data = encode_tile([items[i] for i in sorted(idx)], z, x, y)
            if data:
                tiles[zxy_to_tileid(z, x, y)] = gzip.compress(data, mtime=0)
                per_zoom[z] += 1
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    with tmp.open("wb") as f:
        w = Writer(f)
        for tid in sorted(tiles):
            w.write_tile(tid, tiles[tid])
        e7 = [round(v * 1e7) for v in bbox]
        w.finalize(
            {
                "tile_type": TileType.MVT,
                "tile_compression": Compression.GZIP,
                "min_zoom": MIN_ZOOM,
                "max_zoom": MAX_ZOOM,
                "min_lon_e7": e7[0],
                "min_lat_e7": e7[1],
                "max_lon_e7": e7[2],
                "max_lat_e7": e7[3],
                "center_zoom": 14,
                "center_lon_e7": (e7[0] + e7[2]) // 2,
                "center_lat_e7": (e7[1] + e7[3]) // 2,
            },
            {
                "name": "SmartCity Astana buildings",
                "attribution": "© OpenStreetMap contributors",
                "vector_layers": [
                    {
                        "id": LAYER,
                        "minzoom": MIN_ZOOM,
                        "maxzoom": MAX_ZOOM,
                        "fields": {
                            "h": "Number",
                            "mh": "Number",
                            "src": "String",
                            "lv": "Number",
                            "kind": "String",
                            "part": "Number",
                            "has_parts": "Number",
                            "oid": "String",
                            "col": "String",
                            "rcol": "String",
                            "roof": "String",
                            "eb": "String",
                            "roofed": "Number",
                            "rs": "Number",
                            "styl": "Number",
                            "lbl": "String",
                        },
                    }
                ],
            },
        )
    tmp.replace(out)
    return {"tiles": len(tiles), "tiles_per_zoom": {str(k): v for k, v in sorted(per_zoom.items())}}


def manifest_json(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"
