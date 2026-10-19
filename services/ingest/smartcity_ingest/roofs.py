"""Approximate roof shapes for the 3D map from OSM `roof:shape` (Simple 3D Buildings tags).

MapLibre fill-extrusion draws only flat-topped prisms, so a tagged roof is rendered as a stack of
thin slices whose footprints shrink with height: a linear profile for pitched roofs (gabled,
hipped, pyramidal, …; an inset rectangle converges to the ridge), a quarter-circle profile for
domes, an ellipsoid for orb/sphere parts. Untagged roofs stay flat — no shape is invented.

Curated landmark overrides (config/landmark_shapes.json) apply only after their checks pass and
mark the result `styl=1`: a simplified stylisation, not an exact model.
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass, field
from pathlib import Path

import shapely
from shapely import affinity
from shapely.geometry import Polygon
from shapely.geometry.base import BaseGeometry

log = logging.getLogger("smartcity_ingest.roofs")

LINEAR = {
    "gabled", "hipped", "half-hipped", "side_hipped", "pyramidal", "saltbox", "gambrel", "mansard",
    "quadruple_saltbox", "cone", "tented", "crosspitched",
}  # fmt: skip
CURVED = {"dome", "onion", "round"}
SPHERE = {"orb", "sphere", "spherical"}
SLICES = {"linear": 5, "curved": 8, "sphere": 24}
MIN_INRADIUS_M = 2.0  # smaller roofs are not worth slicing at city zooms
PITCH = math.tan(math.radians(30))  # default pitch when roof:height is not tagged


@dataclass
class Piece:
    geom: BaseGeometry
    props: dict


@dataclass
class LandmarkShape:
    osm: str  # "way/123" or "relation/123"
    shape: str  # "sphere"
    label: str
    note: str
    parent: str | None = None
    parent_tags: dict = field(default_factory=dict)
    expected_center: tuple[float, float] | None = None  # lon, lat of the OSM element when curated
    max_offset_m: float = 30.0
    min_circularity: float = 0.9

    @property
    def area_id(self) -> int:
        kind, ident = self.osm.split("/")
        return int(ident) * 2 + (1 if kind == "relation" else 0)

    @property
    def parent_area_id(self) -> int | None:
        if not self.parent:
            return None
        kind, ident = self.parent.split("/")
        return int(ident) * 2 + (1 if kind == "relation" else 0)


def load_landmarks(path: Path) -> list[LandmarkShape]:
    if not path.is_file():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for d in data.get("landmarks", []):
        c = d.get("expected_center")
        out.append(
            LandmarkShape(
                osm=d["osm"],
                shape=d["shape"],
                label=d["label"],
                note=d["note"],
                parent=d.get("parent"),
                parent_tags=d.get("parent_tags", {}),
                expected_center=(c[0], c[1]) if c else None,
                max_offset_m=float(d.get("max_offset_m", 30.0)),
                min_circularity=float(d.get("min_circularity", 0.9)),
            )
        )
    return out


def circularity(g: BaseGeometry) -> float:
    """4πA/P² — 1.0 for a circle. Lon/lat input is first scaled to local metres (lon shrinks by cos φ)."""
    if g.bounds[2] <= 180 and abs(g.bounds[3]) <= 90:
        k = math.cos(math.radians(g.centroid.y))
        g = affinity.scale(g, xfact=k, yfact=1.0, origin=g.centroid)
    return 4 * math.pi * g.area / (g.length**2) if g.length else 0.0


def inradius(poly: Polygon) -> float:
    """Radius of the largest inscribed circle (in the geometry's units)."""
    line = shapely.maximum_inscribed_circle(poly, tolerance=max(poly.length / 2000, 0.05))
    return line.length


def _parse_m(value) -> float | None:
    try:
        v = float(str(value).replace(",", ".").replace("m", "").strip())
    except (TypeError, ValueError):
        return None
    return v if 0 < v < 300 else None


def roof_kind(shape: str | None) -> str | None:
    if not shape:
        return None
    s = shape.strip().lower()
    if s in SPHERE:
        return "sphere"
    if s in CURVED:
        return "curved"
    if s in LINEAR:
        return "linear"
    return None


def slice_roof(
    geom: BaseGeometry, props: dict, roof_tag_height: float | None, scale: float
) -> tuple[list[Piece], str | None]:
    """Body + roof slices for one building (Web Mercator geometry; `scale` = true metres per unit).

    Returns ([geom] unchanged, None) when the roof is flat, untagged or too small to show.
    """
    kind = roof_kind(props.get("roof"))
    whole = [Piece(geom, props)]
    if geom.geom_type == "MultiPolygon" and len(geom.geoms) == 1:
        geom = geom.geoms[0]  # osmium assembles every area as a MultiPolygon
    if kind is None or geom.geom_type != "Polygon":
        return whole, None
    h, mh = float(props["h"]), float(props.get("mh") or 0.0)
    if kind == "sphere":
        return ellipsoid(geom, props, mh, h), "sphere"
    r = inradius(geom)
    r_true = r * scale
    if r_true < MIN_INRADIUS_M or h - mh < 2:
        return whole, None
    if roof_tag_height is not None:
        roof_h = min(roof_tag_height, 0.9 * (h - mh))
    elif kind == "curved":
        roof_h = min(r_true * (1.0 if props["roof"] != "round" else 0.6), 0.6 * (h - mh))
    else:
        roof_h = min(r_true * (1.0 if props["roof"] == "cone" else PITCH), 0.5 * (h - mh))
    if roof_h < 1.0:
        return whole, None
    eaves = h - roof_h
    pieces = [Piece(geom, {**props, "h": round(eaves, 2), "roofed": 1})]
    n = SLICES[kind]
    for i in range(n):
        t0, t1 = i / n, (i + 1) / n
        tm = (t0 + t1) / 2
        inset = r * tm if kind == "linear" else r * (1 - math.sqrt(1 - tm * tm))
        g = geom.buffer(-inset, join_style="mitre") if inset > 0 else geom
        if g.is_empty or g.area <= 0:
            break
        pieces.append(Piece(g, _slice_props(props, eaves + roof_h * t0, eaves + roof_h * t1)))
    return pieces, kind


def ellipsoid(geom: BaseGeometry, props: dict, base: float, top: float, n: int | None = None) -> list[Piece]:
    """Stack of horizontal slices approximating an ellipsoid spanning [base, top] over the footprint."""
    n = n or SLICES["sphere"]
    c = geom.centroid
    zc, semi = (base + top) / 2, (top - base) / 2
    out = []
    for i in range(n):
        z0 = base + (top - base) * i / n
        z1 = base + (top - base) * (i + 1) / n
        t = ((z0 + z1) / 2 - zc) / semi
        f = math.sqrt(max(0.0, 1 - t * t))
        if f < 0.05:
            continue
        g = affinity.scale(geom, xfact=f, yfact=f, origin=c)
        out.append(Piece(g, _slice_props(props, z0, z1)))
    return out


def sphere_on_stem(geom: BaseGeometry, props: dict, scale: float) -> list[Piece]:
    """Stylised sphere: diameter = footprint diameter (true metres), top at the OSM height, on a narrow
    stem when the height exceeds the diameter. A simplification, never an exact model."""
    h, mh = float(props["h"]), float(props.get("mh") or 0.0)
    diameter = 2 * math.sqrt(geom.area * scale * scale / math.pi)
    base = max(mh, h - diameter)
    pieces = ellipsoid(geom, props, base, h)
    if base - mh > 1.0:
        stem = affinity.scale(geom, xfact=0.3, yfact=0.3, origin=geom.centroid)
        pieces.insert(0, Piece(stem, _slice_props(props, mh, base)))
    return pieces


def _slice_props(props: dict, base: float, top: float) -> dict:
    keep = {k: props[k] for k in ("src", "kind", "part", "rcol", "col", "styl", "eb") if k in props}
    return {**keep, "h": round(top, 2), "mh": round(base, 2), "rs": 1}


def offset_m(lonlat_a: tuple[float, float], lonlat_b: tuple[float, float]) -> float:
    lat = math.radians((lonlat_a[1] + lonlat_b[1]) / 2)
    dx = (lonlat_a[0] - lonlat_b[0]) * 111_320 * math.cos(lat)
    dy = (lonlat_a[1] - lonlat_b[1]) * 110_540
    return math.hypot(dx, dy)


def verify_landmark(
    lm: LandmarkShape, geom_lonlat: BaseGeometry, parent_lonlat: BaseGeometry | None, parent_tags: dict | None
) -> list[str]:
    """Reasons the override must NOT be applied (empty list = all checks passed)."""
    problems = []
    circ = circularity(geom_lonlat)
    if circ < lm.min_circularity:
        problems.append(f"footprint not circular enough ({circ:.2f} < {lm.min_circularity})")
    if lm.parent:
        if parent_lonlat is None:
            problems.append(f"parent {lm.parent} not found")
        elif not parent_lonlat.buffer(1e-5).contains(geom_lonlat.centroid):
            problems.append(f"centroid outside parent {lm.parent}")
        for k, v in lm.parent_tags.items():
            if (parent_tags or {}).get(k) != v:
                problems.append(f"parent tag {k}={v} missing")
    if lm.expected_center:
        c = geom_lonlat.centroid
        d = offset_m((c.x, c.y), lm.expected_center)
        if d > lm.max_offset_m:
            problems.append(f"centroid {d:.0f} m from the curated position")
    return problems
