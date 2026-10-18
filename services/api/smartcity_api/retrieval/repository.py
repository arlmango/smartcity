"""Read-only data access for places, evidence, coverage and the embedding index.

All SQL is parameterized; no user string is interpolated into SQL text.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import String, bindparam, text
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Session


@dataclass
class EvidenceRow:
    id: int
    field: str
    source_url: str
    source_license: str
    collected_at: datetime
    source_value: str


@dataclass
class PlaceRow:
    id: uuid.UUID
    source_type: str
    source_id: int
    name: str
    name_is_generic: bool
    names: dict
    category: str
    subcategory: str
    tags: dict
    description: str
    address: dict
    opening_hours_raw: str | None
    website: str | None
    amenities: dict
    fetched_at: datetime
    source_updated_at: datetime | None
    lat: float
    lon: float
    content_hash: str
    evidence: list[EvidenceRow] = field(default_factory=list)

    @property
    def pid(self) -> str:
        return str(self.id)


_PLACE_COLS = """
    p.id, p.source_type, p.source_id, p.name, p.name_is_generic, p.names, p.category, p.subcategory,
    p.tags, p.description, p.address, p.opening_hours_raw, p.website, p.amenities, p.fetched_at,
    p.source_updated_at, ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lon,
    p.content_hash
"""


def _row_to_place(r) -> PlaceRow:
    return PlaceRow(
        id=r.id,
        source_type=r.source_type,
        source_id=int(r.source_id),
        name=r.name,
        name_is_generic=bool(r.name_is_generic),
        names=r.names or {},
        category=r.category,
        subcategory=r.subcategory,
        tags=r.tags or {},
        description=r.description or "",
        address=r.address or {},
        opening_hours_raw=r.opening_hours_raw,
        website=r.website,
        amenities=r.amenities or {},
        fetched_at=r.fetched_at,
        source_updated_at=r.source_updated_at,
        lat=float(r.lat),
        lon=float(r.lon),
        content_hash=r.content_hash,
    )


def attach_evidence(session: Session, places: list[PlaceRow]) -> None:
    if not places:
        return
    stmt = text(
        "SELECT id, place_id, field, source_url, source_license, collected_at, source_value "
        "FROM place_evidence WHERE place_id = ANY(:ids) ORDER BY id"
    ).bindparams(bindparam("ids", type_=ARRAY(UUID(as_uuid=True))))
    by_id = {p.id: p for p in places}
    for r in session.execute(stmt, {"ids": list(by_id)}):
        by_id[r.place_id].evidence.append(
            EvidenceRow(r.id, r.field, r.source_url, r.source_license, r.collected_at, r.source_value)
        )


def shortlist(
    session: Session, *, lat: float, lon: float, radius_m: float, limit: int = 400
) -> list[PlaceRow]:
    """Active places within a geography radius (padded; exact haversine check happens later)."""
    stmt = text(
        f"SELECT {_PLACE_COLS} FROM places p "  # noqa: S608 - static column list, values are bound
        "WHERE p.active AND ST_DWithin(p.location, "
        "ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography, :radius) "
        "ORDER BY p.location <-> ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography "
        "LIMIT :limit"
    )
    rows = session.execute(stmt, {"lat": lat, "lon": lon, "radius": radius_m * 1.02 + 5, "limit": limit})
    places = [_row_to_place(r) for r in rows]
    attach_evidence(session, places)
    return places


def get_place(session: Session, place_id: uuid.UUID) -> PlaceRow | None:
    stmt = text(f"SELECT {_PLACE_COLS} FROM places p WHERE p.id = :id AND p.active")  # noqa: S608
    r = session.execute(stmt, {"id": place_id}).first()
    if r is None:
        return None
    place = _row_to_place(r)
    attach_evidence(session, [place])
    return place


def places_in_bbox(
    session: Session, *, bbox: tuple[float, float, float, float], category: str | None, limit: int
) -> tuple[list[PlaceRow], bool]:
    params: dict = {
        "minlon": bbox[0],
        "minlat": bbox[1],
        "maxlon": bbox[2],
        "maxlat": bbox[3],
        "lim": limit + 1,
    }
    cat_sql = ""
    if category:
        cat_sql = " AND p.category = :category"
        params["category"] = category
    stmt = text(
        f"SELECT {_PLACE_COLS} FROM places p WHERE p.active "  # noqa: S608
        "AND ST_Intersects(p.location::geometry, ST_MakeEnvelope(:minlon, :minlat, :maxlon, :maxlat, 4326))"
        f"{cat_sql} ORDER BY p.name, p.id LIMIT :lim"
    )
    rows = [_row_to_place(r) for r in session.execute(stmt, params)]
    return rows[:limit], len(rows) > limit


def _escape_like(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def search_places(session: Session, *, q: str, categories: list[str], limit: int) -> list[PlaceRow]:
    """Lexical point search over name / names / address (+ category label matches)."""
    pattern = f"%{_escape_like(q)}%"
    stmt = text(
        f"SELECT {_PLACE_COLS}, "  # noqa: S608
        "CASE WHEN p.name ILIKE :prefix ESCAPE '\\' THEN 0 WHEN p.name ILIKE :pat ESCAPE '\\' THEN 1 "
        "WHEN p.names::text ILIKE :pat ESCAPE '\\' THEN 2 WHEN p.address::text ILIKE :pat ESCAPE '\\' THEN 3 "
        "ELSE 4 END AS rank "
        "FROM places p WHERE p.active AND ("
        "p.name ILIKE :pat ESCAPE '\\' OR p.names::text ILIKE :pat ESCAPE '\\' "
        "OR p.address::text ILIKE :pat ESCAPE '\\' OR p.category = ANY(:cats)) "
        "ORDER BY rank, p.name_is_generic, p.name, p.id LIMIT :lim"
    ).bindparams(bindparam("cats", type_=ARRAY(String())))
    rows = session.execute(
        stmt, {"pat": pattern, "prefix": f"{_escape_like(q)}%", "cats": categories, "lim": limit}
    )
    return [_row_to_place(r) for r in rows]


@dataclass
class CoverageRow:
    id: str
    name: str
    geometry: dict
    dataset_version: str
    freshness: datetime | None
    place_count: int
    updated_at: datetime | None
    bbox: list[float]


def load_coverage(session: Session) -> list[CoverageRow]:
    stmt = text(
        "SELECT id, name, ST_AsGeoJSON(geom) AS gj, dataset_version, freshness, place_count, updated_at, "
        "ST_XMin(geom) AS x0, ST_YMin(geom) AS y0, ST_XMax(geom) AS x1, ST_YMax(geom) AS y1 "
        "FROM coverage ORDER BY updated_at DESC NULLS LAST, id"
    )
    out = []
    for r in session.execute(stmt):
        out.append(
            CoverageRow(
                id=r.id,
                name=r.name,
                geometry=json.loads(r.gj),
                dataset_version=r.dataset_version,
                freshness=r.freshness,
                place_count=int(r.place_count or 0),
                updated_at=r.updated_at,
                bbox=[float(r.x0), float(r.y0), float(r.x1), float(r.y1)],
            )
        )
    return out


def point_in_coverage(session: Session, *, lat: float, lon: float) -> bool:
    stmt = text(
        "SELECT EXISTS (SELECT 1 FROM coverage "
        "WHERE ST_Covers(geom, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)))"
    )
    return bool(session.execute(stmt, {"lat": lat, "lon": lon}).scalar())


def count_active_places(session: Session) -> int:
    return int(session.execute(text("SELECT count(*) FROM places WHERE active")).scalar() or 0)


def find_place_by_names(session: Session, patterns: list[str]) -> PlaceRow | None:
    for pat in patterns:
        stmt = text(
            f"SELECT {_PLACE_COLS} FROM places p WHERE p.active AND "  # noqa: S608
            "(p.name ILIKE :pat OR p.names::text ILIKE :pat) ORDER BY p.name_is_generic, p.id LIMIT 1"
        )
        r = session.execute(stmt, {"pat": pat}).first()
        if r is not None:
            return _row_to_place(r)
    return None


@dataclass
class IndexStat:
    model_id: str
    dim: int
    count: int
    fresh: int  # rows whose content_hash matches the active place


def index_stats(session: Session) -> list[IndexStat]:
    stmt = text(
        "SELECT e.model_id, e.dim, count(*) AS n, "
        "count(*) FILTER (WHERE e.content_hash = p.content_hash) AS fresh "
        "FROM place_embeddings e JOIN places p ON p.id = e.place_id AND p.active "
        "GROUP BY e.model_id, e.dim ORDER BY n DESC"
    )
    return [IndexStat(r.model_id, int(r.dim), int(r.n), int(r.fresh)) for r in session.execute(stmt)]


def semantic_scores(
    session: Session, *, query_vec: list[float], model_id: str, dim: int, place_ids: list[uuid.UUID]
) -> dict[uuid.UUID, float]:
    """Cosine similarity for candidates, restricted to one model_id + dim (no mixed vector spaces).

    Embeddings whose content_hash no longer matches the place are stale and ignored.
    """
    if not place_ids or len(query_vec) != dim:
        return {}
    vec_literal = "[" + ",".join(f"{float(x):.7g}" for x in query_vec) + "]"
    stmt = text(
        "WITH cand AS MATERIALIZED ("
        "  SELECT e.place_id, e.embedding FROM place_embeddings e JOIN places p ON p.id = e.place_id "
        "  WHERE e.model_id = :model AND e.dim = :dim AND e.content_hash = p.content_hash "
        "  AND e.place_id = ANY(:ids)"
        ") SELECT place_id, 1 - (embedding <=> CAST(:q AS vector)) AS cos FROM cand"
    ).bindparams(bindparam("ids", type_=ARRAY(UUID(as_uuid=True))))
    rows = session.execute(stmt, {"model": model_id, "dim": dim, "ids": place_ids, "q": vec_literal})
    return {r.place_id: float(r.cos) for r in rows}
