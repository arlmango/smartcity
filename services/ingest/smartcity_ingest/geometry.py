"""Overpass element -> shapely geometry (always lon/lat order).

Relations of type multipolygon are assembled from member ways: outer and inner lines are merged
into rings with shapely (linemerge + polygonize), inner rings become holes. Invalid results are
repaired with make_valid and reduced to their polygonal part.
"""

from __future__ import annotations

import math

from shapely import make_valid
from shapely.geometry import GeometryCollection, LineString, MultiPolygon, Point, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import linemerge, polygonize, unary_union

# Local metric approximation around Astana (equirectangular), adequate for <= few km distances.
LAT0 = 51.09
M_PER_DEG_LAT = 111_320.0
M_PER_DEG_LON = 111_320.0 * math.cos(math.radians(LAT0))

AREA_KEYS_LINEAR = {"highway", "barrier", "waterway", "railway", "power"}


def _coords(geometry: list | None) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for p in geometry or []:
        if p and "lat" in p and "lon" in p:
            out.append((float(p["lon"]), float(p["lat"])))
    return out


def polygonal(geom: BaseGeometry) -> BaseGeometry | None:
    """Return only the Polygon/MultiPolygon part of geom (after make_valid), or None."""
    if geom.is_empty:
        return None
    if not geom.is_valid:
        geom = make_valid(geom)
    if isinstance(geom, Polygon | MultiPolygon):
        return geom
    if isinstance(geom, GeometryCollection):
        polys = [g for g in geom.geoms if isinstance(g, Polygon | MultiPolygon)]
        if not polys:
            return None
        u = unary_union(polys)
        return u if isinstance(u, Polygon | MultiPolygon) else None
    return None


def way_is_area(tags: dict, coords: list) -> bool:
    if len(coords) < 4 or coords[0] != coords[-1]:
        return False
    if tags.get("area") == "no":
        return False
    if tags.get("area") == "yes":
        return True
    return not any(k in tags for k in AREA_KEYS_LINEAR) or "building" in tags


def way_geometry(el: dict, *, force_line: bool = False) -> BaseGeometry | None:
    coords = _coords(el.get("geometry"))
    if len(coords) < 2:
        return None
    tags = el.get("tags") or {}
    if not force_line and way_is_area(tags, coords):
        return polygonal(Polygon(coords))
    return LineString(coords)


def _rings(lines: list[LineString]) -> list[Polygon]:
    if not lines:
        return []
    merged = linemerge(lines)
    return [p for p in polygonize(merged) if p.area > 0]


def relation_geometry(el: dict) -> BaseGeometry | None:
    """Assemble a multipolygon relation (outer/inner members with geometry)."""
    outer: list[LineString] = []
    inner: list[LineString] = []
    for m in el.get("members", []):
        if m.get("type") != "way":
            continue
        coords = _coords(m.get("geometry"))
        if len(coords) < 2:
            continue
        (inner if m.get("role") == "inner" else outer).append(LineString(coords))
    outers = _rings(outer)
    if not outers:
        return None
    inners = _rings(inner)
    # Even-odd handling for rings nested within outer rings: an "outer" ring fully inside another
    # outer ring (island inside a hole) is kept by union after subtracting holes.
    shell = unary_union(outers)
    if inners:
        shell = shell.difference(unary_union(inners))
    return polygonal(shell)


def element_geometry(el: dict) -> BaseGeometry | None:
    t = el.get("type")
    if t == "node":
        if "lat" in el and "lon" in el:
            return Point(float(el["lon"]), float(el["lat"]))
        return None
    if t == "way":
        return way_geometry(el)
    if t == "relation":
        if (el.get("tags") or {}).get("type") in ("multipolygon", "boundary"):
            return relation_geometry(el)
        return None
    return None


def element_center(el: dict) -> Point | None:
    if el.get("type") == "node" and "lat" in el:
        return Point(float(el["lon"]), float(el["lat"]))
    c = el.get("center")
    if c:
        return Point(float(c["lon"]), float(c["lat"]))
    g = element_geometry(el)
    return representative_point(g) if g is not None else None


def representative_point(geom: BaseGeometry) -> Point:
    if isinstance(geom, Point):
        return geom
    if isinstance(geom, LineString):
        return geom.interpolate(0.5, normalized=True)
    return geom.representative_point()


def distance_m(a: BaseGeometry, b: BaseGeometry) -> float:
    """Approximate metric distance between geometries (0 if they intersect)."""
    from shapely import affinity

    sa = affinity.scale(a, xfact=M_PER_DEG_LON, yfact=M_PER_DEG_LAT, origin=(0, 0))
    sb = affinity.scale(b, xfact=M_PER_DEG_LON, yfact=M_PER_DEG_LAT, origin=(0, 0))
    return float(sa.distance(sb))


def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6_371_008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def bearing_deg(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def round_coords(geom: BaseGeometry, ndigits: int = 6) -> BaseGeometry:
    from shapely import set_precision

    return set_precision(geom, 10 ** (-ndigits))


def bbox(geom: BaseGeometry) -> list[float]:
    minx, miny, maxx, maxy = geom.bounds
    return [round(minx, 7), round(miny, 7), round(maxx, 7), round(maxy, 7)]
