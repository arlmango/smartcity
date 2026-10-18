"""Pure normalization tests on SYNTHETIC fixtures (no DB)."""

from __future__ import annotations

from smartcity_ingest.geometry import element_geometry, relation_geometry
from smartcity_ingest.normalize import (
    build_context,
    classify,
    normalize_name,
    normalize_places,
    safe_website,
)


def _records(groups, coverage, with_buildings=True):
    poi = []
    for g in ("poi_cafe_food", "poi_culture", "poi_attraction", "poi_park_playground", "poi_mall"):
        poi.extend(groups[g])
    blds = [element_geometry(e) for e in groups["map_buildings"]] if with_buildings else None
    ctx = build_context(groups["poi_mall"], blds)
    stats: dict = {}
    recs = normalize_places(poi, coverage.geometry, ctx, stats)
    return {r.name: r for r in recs}, recs, stats


def test_website_rejects_javascript_and_non_http():
    assert safe_website("javascript:alert(1)") is None
    assert safe_website("JaVaScRiPt:alert(1)") is None
    assert safe_website("data:text/html,<b>x</b>") is None
    assert safe_website("www.example.kz") is None
    assert safe_website("https://user@evil.example/") is None
    assert safe_website("https://example.org/a b") is None
    assert safe_website("https://example.org/bistro") == "https://example.org/bistro"
    assert safe_website("http://example.kz") == "http://example.kz"


def test_classify_contract_categories():
    assert classify({"amenity": "ice_cream"}) == ("cafe", "ice_cream")
    assert classify({"amenity": "fast_food"}) == ("food", "fast_food")
    assert classify({"leisure": "garden"}) == ("park", "garden")
    assert classify({"amenity": "cinema", "shop": "mall"}) == ("culture", "cinema")
    assert classify({"historic": "memorial"}) == ("attraction", "memorial")
    assert classify({"leisure": "playground"}) == ("playground", "playground")
    assert classify({"shop": "mall"}) == ("mall", "mall")
    assert classify({"amenity": "bank"}) is None


def test_normalize_name():
    assert normalize_name("SYNTH Кафе «Дубль»") == normalize_name("synth  кафе дубль")
    assert normalize_name("Ёлка") == normalize_name("елка")


def test_T22_relation_multipolygon_with_hole_and_lon_lat(fixture_groups, coverage):
    rel = fixture_groups["poi_park_playground"][0]
    g = relation_geometry(rel)
    assert g is not None and g.is_valid and g.geom_type == "Polygon"
    assert len(g.interiors) == 1  # inner ring kept as a hole
    minx, miny, maxx, maxy = g.bounds
    assert 71.0 < minx < 72.0 and 51.0 < miny < 52.0  # x = lon, y = lat
    by_name, _, _ = _records(fixture_groups, coverage)
    park = by_name["SYNTH Парк с прудом"]
    assert park.source_type == "relation" and park.geom.geom_type == "Polygon"
    assert len(park.geom.interiors) == 1
    # representative point lies inside the polygon, not in the hole
    assert park.geom.contains(park.location)
    lon, lat = park.location.x, park.location.y
    assert 71.39 < lon < 71.445 and 51.075 < lat < 51.115
    assert park.bbox[0] < park.bbox[2] and park.bbox[1] < park.bbox[3]
    assert park.amenities["indoor"] == {"value": False, "basis": "category_rule"}


def test_T19_node_way_duplicate_merged_into_polygon(fixture_groups, coverage):
    by_name, recs, stats = _records(fixture_groups, coverage)
    dubl = [r for r in recs if normalize_name(r.name) == normalize_name("SYNTH Кафе Дубль")]
    # way/9001 + node/1001 (60 m rule) -> one record; node/1002 is ~1 km away -> separate
    assert sorted(r.key for r in dubl) == [("node", 1002), ("way", 9001)]
    way = next(r for r in dubl if r.source_type == "way")
    assert [a["source_id"] for a in way.aliases] == [1001]
    assert way.aliases[0]["url"] == "https://www.openstreetmap.org/node/1001"
    # node-only tags fill the polygon record, with evidence pointing to the node
    assert way.opening_hours_raw == "Mo-Su 09:00-21:00"
    oh_ev = next(e for e in way.evidence if e.field == "opening_hours")
    assert oh_ev.source_url == "https://www.openstreetmap.org/node/1001"
    assert len(stats["dedup_merges"]) == 1


def test_only_named_except_generic_playground(fixture_groups, coverage):
    by_name, recs, stats = _records(fixture_groups, coverage)
    assert stats["skipped_unnamed"] == 1  # unnamed cafe node/1007
    assert stats["skipped_outside_coverage"] == 1  # node/1008
    pg = [r for r in recs if r.category == "playground"]
    assert len(pg) == 1 and pg[0].name == "Детская площадка" and pg[0].name_is_generic
    assert pg[0].names == {}
    assert pg[0].amenities["kids"]["value"] is True


def test_amenities_evidence_from_tags(fixture_groups, coverage):
    by_name, _, _ = _records(fixture_groups, coverage)
    r = by_name["SYNTH Розеточная"]
    a = r.amenities
    assert a["socket"] == {"value": True, "basis": "tag"}
    assert a["wifi"] == {"value": True, "basis": "tag"}
    assert a["outdoor_seating"] == {"value": False, "basis": "tag"}
    assert a["wheelchair"] == {"value": None, "basis": None, "note": "limited"}
    assert a["indoor"]["value"] is None and a["kids"]["value"] is None
    vals = {(e.field, e.source_value, e.source_url) for e in r.evidence}
    url = "https://www.openstreetmap.org/node/1004"
    assert ("socket", "power_supply=yes", url) in vals
    assert ("wifi", "internet_access=wlan", url) in vals
    assert ("outdoor_seating", "outdoor_seating=no", url) in vals
    assert ("wheelchair", "wheelchair=limited", url) in vals
    assert r.address["formatted"] == "SYNTH улица, 1"


def test_indoor_category_rules(fixture_groups, coverage):
    by_name, _, _ = _records(fixture_groups, coverage)
    in_mall = by_name["SYNTH Кофейня в ТРЦ"]
    assert in_mall.amenities["indoor"] == {"value": True, "basis": "category_rule"}
    ev = next(e for e in in_mall.evidence if e.field == "indoor")
    assert ev.source_value == "Внутри ТРЦ SYNTH Молл (OSM way/9101)"
    assert "внутри ТРЦ SYNTH Молл" in in_mall.description
    assert by_name["SYNTH Музей"].amenities["indoor"] == {"value": True, "basis": "category_rule"}
    assert by_name["SYNTH Молл"].amenities["indoor"]["value"] is True
    assert by_name["SYNTH Скульптура"].amenities["indoor"] == {"value": False, "basis": "category_rule"}
    # without building data the artwork rule cannot be evaluated -> unknown
    by_name2, _, _ = _records(fixture_groups, coverage, with_buildings=False)
    assert by_name2["SYNTH Скульптура"].amenities["indoor"]["value"] is None


def test_website_and_description_from_facts_only(fixture_groups, coverage):
    by_name, _, stats = _records(fixture_groups, coverage)
    assert by_name["SYNTH Ресторан"].website is None
    assert stats["website_rejected"] == 1
    b = by_name["SYNTH Бистро"]
    assert b.website == "https://example.org/bistro"
    assert "Описание в OSM: SYNTH описание из тега" in b.description
    cafe = next(r for r in by_name.values() if r.source_type == "way" and r.category == "cafe")
    assert "Кухня: кофейня." in cafe.description
    assert "Часы работы (OSM): Mo-Su 09:00-21:00." in cafe.description


def test_content_hash_stable_and_sensitive(fixture_groups, coverage):
    _, recs1, _ = _records(fixture_groups, coverage)
    _, recs2, _ = _records(fixture_groups, coverage)
    assert {r.key: r.content_hash for r in recs1} == {r.key: r.content_hash for r in recs2}
    fixture_groups["poi_culture"][0]["tags"]["opening_hours"] = "Tu-Su 10:00-18:00"
    _, recs3, _ = _records(fixture_groups, coverage)
    h1 = {r.key: r.content_hash for r in recs1}
    h3 = {r.key: r.content_hash for r in recs3}
    changed = [k for k in h1 if h1[k] != h3[k]]
    assert changed == [("node", 1101)]
