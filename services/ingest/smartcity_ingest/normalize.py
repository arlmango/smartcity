"""OSM elements -> normalized place records (no DB access).

Everything written here is derived from actual OSM tags or computed geometry relations
(e.g. "point inside a shop=mall outline"). Nothing is invented: missing data stays missing.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from urllib.parse import urlsplit

from shapely.geometry import Point
from shapely.geometry.base import BaseGeometry
from shapely.prepared import prep

from smartcity_ingest.geometry import (
    bbox,
    distance_m,
    element_geometry,
    representative_point,
    round_coords,
)
from smartcity_ingest.snapshot import parse_osm_ts

LICENSE = "ODbL-1.0"
DEDUP_MAX_DISTANCE_M = 60.0
FEATURES = ("socket", "wifi", "outdoor_seating", "wheelchair", "indoor", "kids")

CATEGORY_LABELS = {
    "cafe": "Кафе",
    "food": "Еда",
    "park": "Парк / сквер",
    "culture": "Культура",
    "attraction": "Достопримечательность",
    "playground": "Детская площадка",
    "mall": "Торговый центр",
}

SUBCATEGORY_LABELS = {
    "cafe": "кафе",
    "ice_cream": "мороженое",
    "restaurant": "ресторан",
    "fast_food": "фастфуд",
    "park": "парк",
    "garden": "сад",
    "museum": "музей",
    "gallery": "галерея",
    "theatre": "театр",
    "cinema": "кинотеатр",
    "arts_centre": "арт-центр",
    "library": "библиотека",
    "attraction": "достопримечательность",
    "viewpoint": "смотровая площадка",
    "artwork": "арт-объект",
    "monument": "монумент",
    "memorial": "мемориал",
    "fountain": "фонтан",
    "playground": "детская площадка",
    "mall": "торговый центр",
}

# Literal translations of OSM cuisine values (no inference beyond the tag itself).
CUISINE_LABELS = {
    "coffee_shop": "кофейня",
    "coffee": "кофе",
    "pizza": "пицца",
    "burger": "бургеры",
    "sushi": "суши",
    "japanese": "японская",
    "italian": "итальянская",
    "kazakh": "казахская",
    "russian": "русская",
    "uzbek": "узбекская",
    "turkish": "турецкая",
    "georgian": "грузинская",
    "chinese": "китайская",
    "korean": "корейская",
    "asian": "азиатская",
    "european": "европейская",
    "american": "американская",
    "international": "интернациональная",
    "regional": "региональная",
    "chicken": "курица",
    "kebab": "кебаб",
    "shawarma": "шаурма",
    "doner": "донер",
    "sandwich": "сэндвичи",
    "steak_house": "стейк-хаус",
    "ice_cream": "мороженое",
    "dessert": "десерты",
    "cake": "торты",
    "pastry": "выпечка",
    "bakery": "пекарня",
    "tea": "чай",
    "breakfast": "завтраки",
    "noodle": "лапша",
    "ramen": "рамен",
    "seafood": "морепродукты",
    "grill": "гриль",
    "barbecue": "барбекю",
    "vegetarian": "вегетарианская",
    "vegan": "веганская",
    "middle_eastern": "ближневосточная",
    "arab": "арабская",
    "indian": "индийская",
    "thai": "тайская",
    "vietnamese": "вьетнамская",
    "french": "французская",
    "mexican": "мексиканская",
    "fish": "рыба",
    "hot_dog": "хот-доги",
    "fries": "картофель фри",
    "bubble_tea": "бабл-ти",
    "juice": "соки",
    "friture": "фритюр",
    "wings": "крылышки",
    "waffle": "вафли",
    "crepe": "блины",
    "pancake": "блины",
}

CULTURE_INDOOR = {"museum", "gallery", "theatre", "cinema", "library", "arts_centre"}


def classify(tags: dict) -> tuple[str, str] | None:
    """Return (category, subcategory) per CONTRACTS §1, or None if not a supported POI."""
    a, t, le, h, s = (tags.get(k) for k in ("amenity", "tourism", "leisure", "historic", "shop"))
    if a in ("cafe", "ice_cream"):
        return "cafe", a
    if a in ("restaurant", "fast_food"):
        return "food", a
    if t in ("museum", "gallery"):
        return "culture", t
    if a in ("theatre", "cinema", "arts_centre", "library"):
        return "culture", a
    if s == "mall":
        return "mall", "mall"
    if le == "playground":
        return "playground", "playground"
    if le in ("park", "garden"):
        return "park", le
    if t in ("attraction", "viewpoint", "artwork"):
        return "attraction", t
    if h in ("monument", "memorial"):
        return "attraction", h
    if a == "fountain":
        return "attraction", "fountain"
    return None


def osm_url(source_type: str, source_id: int) -> str:
    return f"https://www.openstreetmap.org/{source_type}/{source_id}"


def normalize_name(name: str) -> str:
    s = unicodedata.normalize("NFKC", name).casefold().replace("ё", "е")
    s = re.sub(r"[\"'«»“”„`’]", "", s)
    s = re.sub(r"[^\w]+", " ", s)
    return " ".join(s.split())


_CTRL = re.compile(r"[\x00-\x20\x7f]")


def safe_website(value: str | None) -> str | None:
    """Accept only explicit http(s) URLs with a host; reject javascript:, data:, etc."""
    if not value:
        return None
    v = value.strip().split(";")[0].strip()
    if not v or _CTRL.search(v):
        return None
    try:
        parts = urlsplit(v)
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc or "@" in parts.netloc:
        return None
    host = parts.hostname or ""
    if "." not in host:
        return None
    return v


def _num(value: str | None) -> float | None:
    if value is None:
        return None
    m = re.fullmatch(r"\s*(\d+(?:[.,]\d+)?)\s*(m|м|meters?)?\s*", str(value))
    if not m:
        return None
    return float(m.group(1).replace(",", "."))


@dataclass
class Evidence:
    field: str
    source_url: str
    source_value: str


@dataclass
class Candidate:
    """A raw OSM element that maps to a POI category."""

    el: dict
    source_type: str
    source_id: int
    category: str
    subcategory: str
    tags: dict
    geom: BaseGeometry
    location: Point
    name: str | None
    aliases: list[dict] = field(default_factory=list)
    tag_origin: dict[str, str] = field(default_factory=dict)  # tag key -> "type/id"
    timestamps: list[datetime] = field(default_factory=list)

    @property
    def ref(self) -> str:
        return f"{self.source_type}/{self.source_id}"

    @property
    def is_area(self) -> bool:
        return self.geom.geom_type in ("Polygon", "MultiPolygon")


@dataclass
class PlaceRecord:
    source_type: str
    source_id: int
    name: str
    name_is_generic: bool
    names: dict
    aliases: list
    geom: BaseGeometry
    location: Point
    bbox: list
    category: str
    subcategory: str
    tags: dict
    description: str
    address: dict
    opening_hours_raw: str | None
    website: str | None
    amenities: dict  # feature -> {"value", "basis", "note"?}
    evidence: list[Evidence]
    source_updated_at: datetime | None
    source_version: int | None
    content_hash: str = ""

    @property
    def key(self) -> tuple[str, int]:
        return (self.source_type, self.source_id)

    def hash_payload(self) -> dict:
        return {
            "name": self.name,
            "name_is_generic": self.name_is_generic,
            "names": self.names,
            "aliases": self.aliases,
            "geom": round_coords(self.geom, 7).wkt,
            "location": [round(self.location.x, 7), round(self.location.y, 7)],
            "category": self.category,
            "subcategory": self.subcategory,
            "tags": self.tags,
            "description": self.description,
            "address": self.address,
            "opening_hours_raw": self.opening_hours_raw,
            "website": self.website,
            "amenities": self.amenities,
            "evidence": [[e.field, e.source_url, e.source_value] for e in self.evidence],
            "source_updated_at": self.source_updated_at.isoformat() if self.source_updated_at else None,
            "source_version": self.source_version,
        }

    def compute_hash(self) -> str:
        blob = json.dumps(self.hash_payload(), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        self.content_hash = hashlib.sha256(blob.encode("utf-8")).hexdigest()
        return self.content_hash


def pick_name(tags: dict) -> str | None:
    for k in ("name:ru", "name", "name:kk", "name:en"):
        v = (tags.get(k) or "").strip()
        if v:
            return v
    return None


def candidates_from_elements(elements: list[dict], coverage: BaseGeometry, stats: dict) -> list[Candidate]:
    cov = prep(coverage)
    out: dict[tuple[str, int], Candidate] = {}
    for el in elements:
        key = (el.get("type"), int(el.get("id", 0)))
        if key in out:
            continue
        tags = el.get("tags") or {}
        cls = classify(tags)
        if cls is None:
            continue
        category, sub = cls
        geom = element_geometry(el)
        if geom is None or geom.is_empty:
            stats["skipped_no_geometry"] = stats.get("skipped_no_geometry", 0) + 1
            continue
        loc = representative_point(geom)
        if not cov.contains(loc):
            stats["skipped_outside_coverage"] = stats.get("skipped_outside_coverage", 0) + 1
            continue
        name = pick_name(tags)
        if name is None and category != "playground":
            stats["skipped_unnamed"] = stats.get("skipped_unnamed", 0) + 1
            continue
        ref = f"{key[0]}/{key[1]}"
        ts = parse_osm_ts(el.get("timestamp"))
        out[key] = Candidate(
            el=el,
            source_type=key[0],
            source_id=key[1],
            category=category,
            subcategory=sub,
            tags=dict(tags),
            geom=geom,
            location=loc,
            name=name,
            tag_origin={k: ref for k in tags},
            timestamps=[ts] if ts else [],
        )
    return list(out.values())


NAME_KEYS = ("name", "name:ru", "name:kk", "name:en", "alt_name", "official_name", "old_name", "short_name")
MIN_PREFIX_LEN = 8


def name_set(tags: dict) -> set[str]:
    """All normalized names of an object (several values in one tag are split on ';')."""
    out: set[str] = set()
    for k in NAME_KEYS:
        for v in (tags.get(k) or "").split(";"):
            n = normalize_name(v)
            if n:
                out.add(n)
    return out


def _compact(n: str) -> str:
    return n.replace(" ", "")


def names_match(a: set[str], b: set[str]) -> str | None:
    """Return the reason if two name sets denote the same object, else None.

    - any shared normalized name (any of NAME_KEYS on either side);
    - or, compacted (spaces removed), one name is a prefix of the other and the shorter has at least
      MIN_PREFIX_LEN characters ("Mega Silk Way" vs "Mega SilkWay Astana"). No transliteration."""
    shared = a & b
    if shared:
        return f"shared name: {sorted(shared)[0]}"
    for x in a:
        for y in b:
            cx, cy = _compact(x), _compact(y)
            short, long_ = sorted((cx, cy), key=len)
            if len(short) >= MIN_PREFIX_LEN and long_.startswith(short):
                return f"name prefix: {x!r} ~ {y!r}"
    return None


def deduplicate(cands: list[Candidate], stats: dict) -> list[Candidate]:
    """Merge a node into a way/relation of the same category when their name sets match
    (see names_match) and the node lies inside the polygon or within DEDUP_MAX_DISTANCE_M.

    The polygon is kept as the primary record; the node becomes an alias (with its URL, names and
    distance) and fills only tags the polygon lacks (evidence for those tags points to the node).
    Pairs that are close but have no matching name are reported in stats["dedup_rejected"]."""
    areas = [c for c in cands if c.source_type in ("way", "relation") and c.name]
    names = {id(c): name_set(c.tags) for c in cands}
    merged_nodes: set[tuple[str, int]] = set()
    merges: list[dict] = []
    rejected: list[dict] = []
    nodes = [c for c in cands if c.source_type == "node" and c.name]
    for c in nodes:
        best: tuple[float, Candidate, str] | None = None
        for a in areas:
            if a.category != c.category:
                continue
            d = 0.0 if a.geom.covers(c.location) else distance_m(a.geom, c.location)
            if d > DEDUP_MAX_DISTANCE_M:
                continue
            reason = names_match(names[id(c)], names[id(a)])
            if reason is None:
                rejected.append(
                    {
                        "a": a.ref,
                        "b": c.ref,
                        "distance_m": round(d, 1),
                        "reason": "same category within 60 m, but no common name",
                    }
                )
                continue
            if best is None or d < best[0]:
                best = (d, a, reason)
        if best is None:
            continue
        d, a, reason = best
        a.aliases.append(
            {
                "source_type": c.source_type,
                "source_id": c.source_id,
                "url": osm_url(c.source_type, c.source_id),
                "name": c.name,
                "distance_m": round(d, 1),
                "inside_polygon": d == 0.0,
                "reason": f"same category; {reason}",
            }
        )
        for k, v in c.tags.items():
            if k not in a.tags:
                a.tags[k] = v
                a.tag_origin[k] = c.ref
        a.timestamps.extend(c.timestamps)
        merged_nodes.add((c.source_type, c.source_id))
        merges.append(
            {
                "primary": a.ref,
                "merged": c.ref,
                "name": c.name,
                "primary_name": a.name,
                "distance_m": round(d, 1),
                "reason": reason,
            }
        )
    # Close same-category node pairs (no polygon involved) are only reported, never merged.
    for i, x in enumerate(nodes):
        for y in nodes[i + 1 :]:
            if x.category == y.category and (x.source_type, x.source_id) not in merged_nodes:
                d = distance_m(x.location, y.location)
                if d <= DEDUP_MAX_DISTANCE_M and names_match(names[id(x)], names[id(y)]) is None:
                    same_contact = any(
                        x.tags.get(k) and x.tags.get(k) == y.tags.get(k)
                        for k in ("phone", "website", "contact:phone", "contact:website", "addr:housenumber")
                    )
                    if d <= 15 and not same_contact:
                        rejected.append(
                            {
                                "a": x.ref,
                                "b": y.ref,
                                "distance_m": round(d, 1),
                                "reason": "nodes <=15 m apart, no common name/phone/website/address",
                            }
                        )
    stats["dedup_merges"] = merges
    stats["dedup_rejected"] = rejected
    return [c for c in cands if (c.source_type, c.source_id) not in merged_nodes]


@dataclass
class Context:
    """Computed spatial context used by category rules."""

    malls: list[tuple[BaseGeometry, str, str]]  # (polygon, name, ref)
    buildings: object | None  # prepared union of building polygons or None if unavailable

    def mall_containing(self, pt: Point) -> tuple[str, str] | None:
        for poly, name, ref in self.malls:
            if poly.covers(pt):
                return name, ref
        return None

    def inside_building(self, pt: Point) -> bool | None:
        if self.buildings is None:
            return None
        return bool(self.buildings.contains(pt))


def build_context(mall_elements: list[dict], building_geoms: list[BaseGeometry] | None) -> Context:
    malls = []
    for el in mall_elements:
        tags = el.get("tags") or {}
        if tags.get("shop") != "mall" or el.get("type") == "node":
            continue
        g = element_geometry(el)
        if g is None or g.geom_type not in ("Polygon", "MultiPolygon"):
            continue
        malls.append((g, pick_name(tags) or "без названия", f"{el['type']}/{el['id']}"))
    bld = None
    if building_geoms is not None:
        from shapely.strtree import STRtree

        tree = STRtree(building_geoms)

        class _Index:
            def contains(self, pt: Point) -> bool:
                return any(building_geoms[i].covers(pt) for i in tree.query(pt))

        bld = _Index()
    return Context(malls=malls, buildings=bld)


def compute_amenities(c: Candidate, ctx: Context) -> tuple[dict, list[Evidence]]:
    tags = c.tags

    def ev(feature: str, key: str) -> Evidence:
        origin = c.tag_origin.get(key, c.ref)
        t, i = origin.split("/")
        return Evidence(feature, osm_url(t, int(i)), f"{key}={tags[key]}"[:200])

    res: dict[str, dict] = {}
    evs: list[Evidence] = []

    def put(feature: str, value, basis, e: Evidence | None, note: str | None = None) -> None:
        d = {"value": value, "basis": basis}
        if note:
            d["note"] = note
        res[feature] = d
        if e is not None:
            evs.append(e)

    # socket
    sockets = [k for k in tags if k.startswith("socket:") and (_num(tags[k]) or 0) > 0]
    if tags.get("power_supply") == "yes":
        put("socket", True, "tag", ev("socket", "power_supply"))
    elif sockets:
        put("socket", True, "tag", ev("socket", sockets[0]))
    elif tags.get("power_supply") == "no":
        put("socket", False, "tag", ev("socket", "power_supply"))
    else:
        put("socket", None, None, None)

    # wifi
    ia = tags.get("internet_access")
    if ia in ("wlan", "yes", "wifi"):
        put("wifi", True, "tag", ev("wifi", "internet_access"))
    elif ia == "no":
        put("wifi", False, "tag", ev("wifi", "internet_access"))
    else:
        put("wifi", None, None, None)

    # outdoor_seating
    os_ = tags.get("outdoor_seating")
    if os_ == "yes":
        put("outdoor_seating", True, "tag", ev("outdoor_seating", "outdoor_seating"))
    elif os_ == "no":
        put("outdoor_seating", False, "tag", ev("outdoor_seating", "outdoor_seating"))
    else:
        put("outdoor_seating", None, None, None)

    # wheelchair
    wc = tags.get("wheelchair")
    if wc == "yes":
        put("wheelchair", True, "tag", ev("wheelchair", "wheelchair"))
    elif wc == "no":
        put("wheelchair", False, "tag", ev("wheelchair", "wheelchair"))
    elif wc == "limited":
        put("wheelchair", None, None, ev("wheelchair", "wheelchair"), note="limited")
    else:
        put("wheelchair", None, None, None)

    # indoor: explicit tags first, then category rules
    origin_url = osm_url(c.source_type, c.source_id)
    if tags.get("indoor") == "yes":
        put("indoor", True, "tag", ev("indoor", "indoor"))
    elif tags.get("location") == "indoor":
        put("indoor", True, "tag", ev("indoor", "location"))
    elif tags.get("indoor") == "no" or tags.get("location") == "outdoor":
        key = "indoor" if tags.get("indoor") == "no" else "location"
        put("indoor", False, "tag", ev("indoor", key))
    elif c.category == "culture" and c.subcategory in CULTURE_INDOOR:
        key = "tourism" if c.subcategory in ("museum", "gallery") else "amenity"
        put("indoor", True, "category_rule", ev("indoor", key))
    elif c.category == "mall":
        put("indoor", True, "category_rule", ev("indoor", "shop"))
    elif c.category in ("cafe", "food") and "level" in tags:
        put("indoor", True, "category_rule", ev("indoor", "level"))
    elif c.category in ("cafe", "food") and (m := ctx.mall_containing(c.location)) is not None:
        mname, mref = m
        mt, mid = mref.split("/")
        put(
            "indoor",
            True,
            "category_rule",
            Evidence("indoor", osm_url(mt, int(mid)), f"Внутри ТРЦ {mname} (OSM {mref})"),
        )
    elif c.category in ("park", "playground"):
        key = "leisure"
        put("indoor", False, "category_rule", ev("indoor", key))
    elif c.subcategory in ("viewpoint", "artwork") and ctx.inside_building(c.location) is False:
        put(
            "indoor",
            False,
            "category_rule",
            Evidence("indoor", origin_url, f"tourism={c.subcategory}; точка вне контуров зданий OSM"),
        )
    else:
        put("indoor", None, None, None)

    # kids
    if tags.get("leisure") == "playground":
        put("kids", True, "tag", ev("kids", "leisure"))
    elif tags.get("kids_area") == "yes":
        put("kids", True, "tag", ev("kids", "kids_area"))
    elif any(k == "playground" or k.startswith("playground:") for k in tags):
        k = "playground" if "playground" in tags else next(k for k in tags if k.startswith("playground:"))
        put("kids", True, "tag", ev("kids", k))
    elif tags.get("kids_area") == "no":
        put("kids", False, "tag", ev("kids", "kids_area"))
    else:
        put("kids", None, None, None)

    return res, evs


ADDRESS_KEYS = (
    "street",
    "housenumber",
    "city",
    "postcode",
    "place",
    "district",
    "suburb",
    "floor",
    "unit",
    "full",
    "country",
    "housename",
)


def build_address(tags: dict) -> dict:
    addr = {k: tags[f"addr:{k}"] for k in ADDRESS_KEYS if tags.get(f"addr:{k}")}
    if "full" not in addr:
        street = addr.get("street") or addr.get("place")
        if street:
            addr["formatted"] = f"{street}, {addr['housenumber']}" if addr.get("housenumber") else street
    else:
        addr["formatted"] = addr["full"]
    if tags.get("level") and "floor" not in addr:
        addr["level"] = tags["level"]
    return addr


def cuisine_text(tags: dict) -> str | None:
    raw = tags.get("cuisine")
    if not raw:
        return None
    vals = [v.strip() for v in raw.split(";") if v.strip()]
    return ", ".join(CUISINE_LABELS.get(v, v.replace("_", " ")) for v in vals)


def build_description(
    c: Candidate, name: str, address: dict, oh: str | None, mall: tuple | None, amen: dict
) -> str:
    cat = CATEGORY_LABELS[c.category]
    sub = SUBCATEGORY_LABELS.get(c.subcategory, c.subcategory)
    parts = [f"{name}. {cat}" + (f" ({sub})" if sub.lower() != cat.lower() else "") + "."]
    if (cu := cuisine_text(c.tags)) is not None:
        parts.append(f"Кухня: {cu}.")
    for k in ("artwork_type", "memorial", "museum"):
        if c.tags.get(k):
            parts.append(f"Тип ({k}): {c.tags[k].replace('_', ' ')}.")
    if address.get("formatted"):
        parts.append(f"Адрес: {address['formatted']}.")
    if mall:
        parts.append(f"Находится внутри ТРЦ {mall[0]}.")
    if oh:
        parts.append(f"Часы работы (OSM): {oh}.")
    flags = {
        "wifi": "Wi-Fi",
        "outdoor_seating": "летняя площадка",
        "wheelchair": "доступно для колясок",
        "socket": "розетки",
    }
    yes = [label for f, label in flags.items() if amen.get(f, {}).get("value") is True]
    if yes:
        parts.append("По тегам OSM: " + ", ".join(yes) + ".")
    desc = (c.tags.get("description:ru") or c.tags.get("description") or "").strip()
    if desc:
        parts.append(f"Описание в OSM: {desc[:500]}")
    return " ".join(parts)


def build_record(c: Candidate, ctx: Context) -> PlaceRecord:
    tags = c.tags
    generic = c.name is None
    name = c.name or "Детская площадка"
    names = {k: tags[f"name:{k}"] for k in ("ru", "kk", "en") if tags.get(f"name:{k}")}
    if tags.get("name"):
        names["default"] = tags["name"]
    if c.name is None:
        names = {}
    address = build_address(tags)
    oh = (tags.get("opening_hours") or "").strip() or None
    raw_site = tags.get("website") or tags.get("contact:website")
    website = safe_website(raw_site)
    amenities, evs = compute_amenities(c, ctx)
    mall = ctx.mall_containing(c.location) if c.category in ("cafe", "food") else None
    description = build_description(c, name, address, oh, mall, amenities)

    def tev(fld: str, key: str) -> Evidence:
        origin = c.tag_origin.get(key, c.ref)
        t, i = origin.split("/")
        return Evidence(fld, osm_url(t, int(i)), f"{key}={tags[key]}"[:200])

    base_ev: list[Evidence] = []
    if not generic:
        nkey = next(k for k in ("name:ru", "name", "name:kk", "name:en") if (tags.get(k) or "").strip())
        base_ev.append(tev("name", nkey))
    cat_key = {
        "cafe": "amenity",
        "food": "amenity",
        "mall": "shop",
        "playground": "leisure",
        "park": "leisure",
    }.get(c.category)
    if cat_key is None:
        cat_key = next(k for k in ("tourism", "amenity", "historic") if tags.get(k) == c.subcategory)
    base_ev.append(tev("category", cat_key))
    if oh:
        base_ev.append(tev("opening_hours", "opening_hours"))
    if website:
        base_ev.append(tev("website", "website" if tags.get("website") else "contact:website"))
    stamps = c.timestamps
    rec = PlaceRecord(
        source_type=c.source_type,
        source_id=c.source_id,
        name=name,
        name_is_generic=generic,
        names=names,
        aliases=c.aliases,
        geom=c.geom,
        location=c.location,
        bbox=bbox(c.geom),
        category=c.category,
        subcategory=c.subcategory,
        tags=tags,
        description=description,
        address=address,
        opening_hours_raw=oh,
        website=website,
        amenities=amenities,
        evidence=base_ev + evs,
        source_updated_at=max(stamps) if stamps else None,
        source_version=int(c.el["version"]) if c.el.get("version") is not None else None,
    )
    rec.compute_hash()
    return rec


def normalize_places(
    poi_elements: list[dict],
    coverage: BaseGeometry,
    ctx: Context,
    stats: dict,
) -> list[PlaceRecord]:
    cands = candidates_from_elements(poi_elements, coverage, stats)
    stats["candidates"] = len(cands)
    cands = deduplicate(cands, stats)
    records = [build_record(c, ctx) for c in cands]
    rejected = sum(
        1
        for c in cands
        if (c.tags.get("website") or c.tags.get("contact:website"))
        and safe_website(c.tags.get("website") or c.tags.get("contact:website")) is None
    )
    stats["website_rejected"] = rejected
    return records
