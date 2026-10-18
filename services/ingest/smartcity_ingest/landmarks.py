"""A04 landmark verification: find reference objects in the snapshot by name/tags and compute
their centroids and mutual positions (distance, bearing) from the OSM geometry itself."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from shapely.geometry import MultiLineString, Point
from shapely.ops import linemerge, nearest_points

from smartcity_ingest.geometry import (
    M_PER_DEG_LAT,
    M_PER_DEG_LON,
    bearing_deg,
    element_geometry,
    haversine_m,
    way_geometry,
)
from smartcity_ingest.paths import CoverageArea
from smartcity_ingest.snapshot import Snapshot


@dataclass(frozen=True)
class Spec:
    key: str
    label: str
    pattern: str
    prefer: tuple[tuple[str, str], ...] = ()
    linear: bool = False
    note: str | None = None
    require_pref: bool = False


SPECS = (
    Spec(
        "nur_alem",
        "Сфера EXPO: Alem.ai (павильон «Нур Алем»)",
        # In this snapshot OSM names the sphere "Alem.ai" (museum=future, addr В1 Мангилик Ел);
        # the name «Нур Алем» itself is not present in OSM tags. Both patterns are searched.
        r"Нур[ -]?Алем|Nur[ -]?Alem|Нұр[ -]?Әлем|^Alem\.ai$",
        (("museum", "future"), ("building", "*"), ("tourism", "*")),
        note="OSM name is 'Alem.ai' (museum=future); identification with the former Nur Alem pavilion "
        "is not stated in OSM tags — verify visually against the sphere outline",
    ),
    Spec(
        "expo_site",
        "Выставочный центр EXPO",
        r"^(EXPO|ЭКСПО|Экспо)$",
        (("amenity", "exhibition_centre"), ("tourism", "*"), ("building", "*")),
    ),
    Spec("expo_quarter", "Квартал ЭКСПО-2017", r"^(ЭКСПО-2017|EXPO-2017)$", (("place", "*"),)),
    Spec(
        "mega_silk_way",
        "ТРЦ MEGA Silk Way",
        r"MEGA\s*Silk\s*Way|Мега\s*Силк\s*Уэй|Mega\s*Silk\s*Way",
        (("shop", "mall"), ("building", "*")),
    ),
    Spec(
        "botanical_garden",
        "Ботанический сад",
        r"Ботанический сад|Ботаникалық бақ|Botanical Garden",
        (("leisure", "garden"), ("leisure", "park")),
    ),
    Spec(
        "nazarbayev_university",
        "Назарбаев Университет",
        r"Назарбаев Университет|Nazarbayev University|Назарбаев Университеті",
        (("amenity", "university"),),
    ),
    Spec(
        "mangilik_el",
        "проспект Мангилик Ел",
        r"Мәңгілік Ел|Мангилик Ел|Mangilik El",
        (("highway", "*"),),
        linear=True,
    ),
    Spec(
        "astana_arena",
        "Астана Арена",
        r"Астана Арена|Astana Arena",
        (("leisure", "stadium"),),
        # The LRT station of the same name (building=train_station) must not be taken for the stadium.
        require_pref=True,
    ),
)


def _name(tags: dict) -> str | None:
    for k in ("name:ru", "name", "name:kk", "name:en"):
        if tags.get(k):
            return tags[k]
    return None


def _matches(tags: dict, rx: re.Pattern) -> bool:
    return any(
        rx.search(tags.get(k) or "") for k in ("name", "name:ru", "name:kk", "name:en", "official_name")
    )


def _pref_score(tags: dict, prefer) -> int:
    for i, (k, v) in enumerate(prefer):
        if k in tags and (v == "*" or tags[k] == v):
            return len(prefer) - i
    return 0


def _all_elements(snapshot: Snapshot) -> list[tuple[str, dict]]:
    out = []
    for g in snapshot.manifest["groups"]:
        for el in snapshot.elements(g):
            out.append((g, el))
    return out


def _metric(g):
    from shapely import affinity

    return affinity.scale(g, xfact=M_PER_DEG_LON, yfact=M_PER_DEG_LAT, origin=(0, 0))


def find_landmarks(snapshot: Snapshot, coverage: CoverageArea) -> list[dict]:
    els = _all_elements(snapshot)
    found = []
    for spec in SPECS:
        rx = re.compile(spec.pattern, re.I)
        if spec.linear:
            ways = {}
            for _g, el in els:
                tags = el.get("tags") or {}
                if (
                    el.get("type") == "way"
                    and "highway" in tags
                    and _matches(tags, rx)
                    and el.get("geometry")
                ):
                    ways[el["id"]] = (el, way_geometry(el, force_line=True))
            if not ways:
                continue
            lines = [geo for _, geo in ways.values() if geo is not None]
            merged = linemerge(MultiLineString(lines))
            clipped = merged.intersection(coverage.geometry)
            c = clipped.centroid if not clipped.is_empty else merged.centroid
            first = next(iter(ways.values()))[0]
            found.append(
                {
                    "key": spec.key,
                    "label": spec.label,
                    "osm": [f"way/{i}" for i in sorted(ways)],
                    "osm_urls_sample": [f"https://www.openstreetmap.org/way/{i}" for i in sorted(ways)[:5]],
                    "name": _name(first.get("tags") or {}),
                    "tags_sample": {
                        k: v
                        for k, v in (first.get("tags") or {}).items()
                        if k in ("highway", "name", "name:ru", "name:kk")
                    },
                    "geometry_type": "LineString (merged ways)",
                    "centroid_lonlat": [round(c.x, 6), round(c.y, 6)],
                    "length_in_coverage_m": round(_metric(clipped).length, 1),
                    "bbox_lonlat": [round(v, 6) for v in merged.bounds],
                    "inside_coverage": bool(coverage.geometry.intersects(merged)),
                    "_line": merged,
                }
            )
            continue
        best = None
        for g, el in els:
            tags = el.get("tags") or {}
            if not _matches(tags, rx):
                continue
            geom = (
                element_geometry(el)
                if el.get("type") == "node" or el.get("geometry") or el.get("members")
                else None
            )
            if geom is not None and geom.geom_type in ("Polygon", "MultiPolygon"):
                centroid, gtype, area = geom.centroid, geom.geom_type, _metric(geom).area
            elif el.get("type") == "node":
                centroid, gtype, area = Point(el["lon"], el["lat"]), "Point", 0.0
            elif el.get("center"):
                centroid, gtype, area = (
                    Point(el["center"]["lon"], el["center"]["lat"]),
                    "center (Overpass)",
                    0.0,
                )
            elif geom is not None:
                centroid, gtype, area = geom.centroid, geom.geom_type, 0.0
            else:
                continue
            score = (_pref_score(tags, spec.prefer), 1 if gtype in ("Polygon", "MultiPolygon") else 0, area)
            if spec.require_pref and score[0] == 0:
                continue
            if best is None or score > best[0]:
                best = (score, el, centroid, gtype, area, g)
        if best is None:
            continue
        _, el, centroid, gtype, area, group = best
        tags = el.get("tags") or {}
        found.append(
            {
                "key": spec.key,
                "label": spec.label,
                "osm": f"{el['type']}/{el['id']}",
                "osm_url": f"https://www.openstreetmap.org/{el['type']}/{el['id']}",
                "name": _name(tags),
                "tags_sample": {
                    k: v
                    for k, v in tags.items()
                    if k
                    in (
                        "name",
                        "name:ru",
                        "name:en",
                        "name:kk",
                        "building",
                        "museum",
                        "place",
                        "addr:street",
                        "addr:housenumber",
                        "shop",
                        "tourism",
                        "leisure",
                        "amenity",
                        "height",
                        "building:levels",
                    )
                },
                "geometry_type": gtype,
                "area_m2": round(area, 1) if area else None,
                "centroid_lonlat": [round(centroid.x, 6), round(centroid.y, 6)],
                "inside_coverage": bool(coverage.geometry.contains(centroid)),
                "snapshot_group": group,
                **({"note": spec.note} if spec.note else {}),
            }
        )
    return found


def _side(line, pt: Point) -> str:
    """Which side of the (merged) line a point lies on, relative to the line's local direction."""
    if isinstance(line, MultiLineString):
        line = min(line.geoms, key=lambda g: g.distance(pt))
    proj = line.project(pt)
    a = line.interpolate(max(0.0, proj - 1e-4))
    b = line.interpolate(min(line.length, proj + 1e-4))
    cross = (b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x)
    brg = bearing_deg(a.x, a.y, b.x, b.y)
    return f"{'left' if cross > 0 else 'right'} of line direction {brg:.0f}°"


def _cardinal(b: float) -> str:
    names = [
        "N",
        "NNE",
        "NE",
        "ENE",
        "E",
        "ESE",
        "SE",
        "SSE",
        "S",
        "SSW",
        "SW",
        "WSW",
        "W",
        "WNW",
        "NW",
        "NNW",
    ]
    return names[int((b + 11.25) // 22.5) % 16]


def write_landmarks(snapshot: Snapshot, coverage: CoverageArea, out: Path) -> dict:
    lms = find_landmarks(snapshot, coverage)
    by = {lm["key"]: lm for lm in lms}
    checks = []
    pts = [lm for lm in lms if lm["key"] != "mangilik_el"]
    for i, a in enumerate(pts):
        for b in pts[i + 1 :]:
            (x1, y1), (x2, y2) = a["centroid_lonlat"], b["centroid_lonlat"]
            brg = bearing_deg(x1, y1, x2, y2)
            checks.append(
                {
                    "from": a["key"],
                    "to": b["key"],
                    "distance_m": round(haversine_m(x1, y1, x2, y2), 1),
                    "bearing_deg": round(brg, 1),
                    "direction": _cardinal(brg),
                }
            )
    if "mangilik_el" in by:
        line = by["mangilik_el"]["_line"]
        for lm in pts:
            p = Point(*lm["centroid_lonlat"])
            q = nearest_points(line, p)[0]
            checks.append(
                {
                    "from": lm["key"],
                    "to": "mangilik_el",
                    "distance_to_line_m": round(haversine_m(p.x, p.y, q.x, q.y), 1),
                    "side": _side(line, p),
                }
            )
    for lm in lms:
        lm.pop("_line", None)
    doc = {
        "purpose": "A04: reference objects matched to OSM IDs; positions computed from snapshot geometry",
        "dataset_version": snapshot.dataset_version,
        "osm_base_timestamp": snapshot.manifest.get("osm_base_timestamp"),
        "generated_at": datetime.now(UTC).isoformat(),
        "method": "name regex over all snapshot groups; polygon centroid (shapely) or node coordinate; "
        "haversine distance (R=6371008.8 m) and initial bearing",
        "coordinate_order": "[lon, lat]",
        "landmarks": lms,
        "checks": checks,
        "not_found": [s.key for s in SPECS if s.key not in by],
        "license": "ODbL-1.0",
        "attribution": "© OpenStreetMap contributors",
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return doc
