"""Dedup by name sets (SYNTHETIC elements modelled on real cases; not real OSM data)."""

from __future__ import annotations

from smartcity_api.db.models import Place
from smartcity_ingest.importer import run_import
from smartcity_ingest.normalize import build_context, name_set, names_match, normalize_places
from sqlalchemy import select
from sqlalchemy.orm import Session

TS = "2025-06-01T10:00:00Z"


def _sq(x0, y0, x1, y1):
    return [
        {"lon": x0, "lat": y0},
        {"lon": x1, "lat": y0},
        {"lon": x1, "lat": y1},
        {"lon": x0, "lat": y1},
        {"lon": x0, "lat": y0},
    ]


# Like way "Mega Silk Way" + node "Мега Силк Вей"/name:en "Mega SilkWay Astana" ~19 m outside the outline.
MALL_WAY = {
    "type": "way",
    "id": 9601,
    "timestamp": TS,
    "version": 1,
    "geometry": _sq(71.4400, 51.1000, 71.4410, 51.1006),
    "tags": {"shop": "mall", "name": "SYNTH Silk Way", "building": "yes"},
}
MALL_NODE = {
    "type": "node",
    "id": 1601,
    "timestamp": TS,
    "version": 1,
    "lon": 71.4413,
    "lat": 51.1003,
    "tags": {
        "shop": "mall",
        "name": "SYNTH Силк Вей",
        "name:en": "SYNTH SilkWay Astana",
        "opening_hours": "Mo-Su 10:00-22:00",
    },
}
# Like "Boom Boom Room" / "Семейное кафе бум": two cafe nodes 6 m apart with no common data.
BOOM_A = {
    "type": "node",
    "id": 1602,
    "timestamp": TS,
    "version": 1,
    "lon": 71.43000,
    "lat": 51.11000,
    "tags": {"amenity": "cafe", "name:ru": "SYNTH Boom Room", "phone": "+70000000000"},
}
BOOM_B = {
    "type": "node",
    "id": 1603,
    "timestamp": TS,
    "version": 1,
    "lon": 71.43008,
    "lat": 51.11002,
    "tags": {"amenity": "cafe", "name": "SYNTH Семейное кафе бум"},
}


def test_names_match_rules():
    assert names_match(
        name_set({"name": "Mega Silk Way"}),
        name_set({"name": "Мега Силк Вей", "name:en": "Mega SilkWay Astana"}),
    )
    assert names_match(name_set({"name": "Кафе «Ромашка»"}), name_set({"alt_name": "кафе ромашка"}))
    assert names_match(name_set({"name": "Boom Boom Room"}), name_set({"name": "Семейное кафе бум"})) is None
    assert names_match(name_set({"name": "Кафе"}), name_set({"name": "Кафе Ромашка"})) is None  # < 8 chars


def _norm(elements, coverage):
    stats: dict = {}
    recs = normalize_places(elements, coverage.geometry, build_context([MALL_WAY], None), stats)
    return {r.key: r for r in recs}, stats


def test_mall_node_merged_by_name_set(coverage):
    recs, stats = _norm([MALL_WAY, MALL_NODE], coverage)
    assert set(recs) == {("way", 9601)}
    way = recs[("way", 9601)]
    alias = way.aliases[0]
    assert (alias["source_type"], alias["source_id"]) == ("node", 1601)
    assert 10 < alias["distance_m"] < 60 and alias["inside_polygon"] is False
    assert alias["url"] == "https://www.openstreetmap.org/node/1601"
    assert way.opening_hours_raw == "Mo-Su 10:00-22:00"
    ev = next(e for e in way.evidence if e.field == "opening_hours")
    assert ev.source_url.endswith("/node/1601")
    assert stats["dedup_merges"][0]["reason"].startswith("name prefix")


def test_close_cafes_without_common_data_not_merged(coverage):
    recs, stats = _norm([BOOM_A, BOOM_B], coverage)
    assert set(recs) == {("node", 1602), ("node", 1603)}
    rej = stats["dedup_rejected"]
    assert len(rej) == 1 and {rej[0]["a"], rej[0]["b"]} == {"node/1602", "node/1603"}


def _rows(engine):
    with Session(engine) as s:
        return {(p.source_type, p.source_id): p for p in s.scalars(select(Place))}


def test_alias_row_deactivated_in_merge_and_idempotent(db, coverage, fixture_groups, make_snapshot):
    g1 = dict(fixture_groups)
    g1["poi_mall"] = fixture_groups["poi_mall"] + [MALL_NODE]  # node alone (no polygon yet)
    run_import(db, make_snapshot(g1), coverage)
    assert _rows(db)[("node", 1601)].active is True
    g2 = dict(fixture_groups)
    g2["poi_mall"] = fixture_groups["poi_mall"] + [MALL_WAY, MALL_NODE]
    # even a partial snapshot performs the merge: both objects are in the snapshot
    res = run_import(db, make_snapshot(g2, failed=("map_roads",)), coverage)
    assert res.status == "partial" and res.counts["merged_into_alias"] == 1
    rows = _rows(db)
    assert rows[("node", 1601)].active is False
    assert rows[("way", 9601)].active and rows[("way", 9601)].aliases[0]["source_id"] == 1601
    res2 = run_import(db, make_snapshot(g2), coverage)
    assert res2.counts.get("inserted", 0) == 0 and res2.counts.get("updated", 0) == 0
    assert res2.counts["merged_into_alias"] == 0 and res2.counts["deactivated"] == 0
    assert sum(p.active for p in _rows(db).values()) == sum(p.active for p in rows.values())
