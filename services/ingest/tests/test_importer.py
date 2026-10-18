"""Import tests on the dedicated test DB (smartcity_test_ingest) with SYNTHETIC fixtures."""

from __future__ import annotations

import pytest
from smartcity_api.db.models import Coverage, IngestRun, Place, PlaceEvidence
from smartcity_ingest import importer
from smartcity_ingest.importer import run_import
from sqlalchemy import select, text
from sqlalchemy.orm import Session


def _places(engine):
    with Session(engine) as s:
        return {(p.source_type, p.source_id): p for p in s.scalars(select(Place))}


def test_import_and_idempotent_reimport(db, coverage, fixture_groups, make_snapshot):
    snap = make_snapshot(fixture_groups)
    r1 = run_import(db, snap, coverage)
    assert r1.status == "complete", r1.error
    n = r1.counts["records"]
    assert r1.counts["inserted"] == n and n == 11
    before = _places(db)
    r2 = run_import(db, snap, coverage)
    assert r2.status == "complete"
    assert r2.counts.get("inserted", 0) == 0 and r2.counts.get("updated", 0) == 0
    assert r2.counts["unchanged"] == n and r2.counts["deactivated"] == 0
    after = _places(db)
    assert len(after) == n
    for k, p in after.items():
        assert p.updated_at == before[k].updated_at
        assert p.content_hash == before[k].content_hash
    with Session(db) as s:
        runs = list(s.scalars(select(IngestRun).order_by(IngestRun.started_at)))
        assert [r.status for r in runs] == ["complete", "complete"]
        assert runs[0].snapshot_hash == snap.snapshot_hash and runs[0].dataset_version == snap.dataset_version
        cov = s.get(Coverage, coverage.id)
        assert cov.place_count == n and cov.dataset_version == snap.dataset_version
        assert cov.freshness.tzinfo is not None


def test_T19_node_way_duplicate_single_row(db, coverage, fixture_groups, make_snapshot):
    run_import(db, make_snapshot(fixture_groups), coverage)
    places = _places(db)
    assert ("way", 9001) in places and ("node", 1001) not in places
    assert places[("way", 9001)].aliases[0]["source_id"] == 1001
    assert ("node", 1002) in places  # same name but far away: kept separately


def test_T20_partial_failure_preserves_records(db, coverage, fixture_groups, make_snapshot):
    run_import(db, make_snapshot(fixture_groups), coverage)
    before = _places(db)
    # The cafe/food group fails, and the remaining groups no longer contain the museum.
    g2 = dict(fixture_groups)
    g2["poi_culture"] = []
    res = run_import(db, make_snapshot(g2, failed=("poi_cafe_food",)), coverage)
    assert res.status == "partial"
    assert res.counts["deactivated"] == 0
    after = _places(db)
    assert set(after) == set(before)
    assert all(p.active for p in after.values())


def test_T20_all_poi_groups_failed_is_failed_and_changes_nothing(db, coverage, fixture_groups, make_snapshot):
    run_import(db, make_snapshot(fixture_groups), coverage)
    before = _places(db)
    poi = ("poi_cafe_food", "poi_culture", "poi_attraction", "poi_park_playground", "poi_mall")
    res = run_import(db, make_snapshot(fixture_groups, failed=poi), coverage)
    assert res.status == "failed" and "no POI query group" in res.error
    after = _places(db)
    assert {k: (p.active, p.content_hash) for k, p in after.items()} == {
        k: (p.active, p.content_hash) for k, p in before.items()
    }
    with Session(db) as s:
        run = s.get(IngestRun, res.run_id)
        assert run.status == "failed" and run.finished_at is not None


def test_failure_mid_transaction_rolls_back(db, coverage, fixture_groups, make_snapshot, monkeypatch):
    calls = {"n": 0}
    orig = importer._write_evidence

    def boom(*a, **kw):
        calls["n"] += 1
        if calls["n"] == 3:
            raise RuntimeError("simulated failure")
        return orig(*a, **kw)

    monkeypatch.setattr(importer, "_write_evidence", boom)
    res = run_import(db, make_snapshot(fixture_groups), coverage)
    assert res.status == "failed"
    assert _places(db) == {}
    with Session(db) as s:
        assert s.scalar(text("select count(*) from place_evidence")) == 0
        assert s.get(IngestRun, res.run_id).status == "failed"


def test_T21_removed_poi_deactivated_only_after_complete_snapshot(
    db, coverage, fixture_groups, make_snapshot
):
    run_import(db, make_snapshot(fixture_groups), coverage)
    g2 = dict(fixture_groups)
    g2["poi_culture"] = []  # museum node/1101 disappears
    # partial snapshot (a map group failed): no tombstones
    res_p = run_import(db, make_snapshot(g2, failed=("map_roads",)), coverage)
    assert res_p.status == "partial"
    assert _places(db)[("node", 1101)].active is True
    # complete snapshot: tombstone (row kept, active=false)
    res_c = run_import(db, make_snapshot(g2), coverage)
    assert res_c.status == "complete" and res_c.counts["deactivated"] == 1
    places = _places(db)
    assert places[("node", 1101)].active is False
    assert sum(p.active for p in places.values()) == len(places) - 1
    with Session(db) as s:
        assert s.get(Coverage, coverage.id).place_count == len(places) - 1
    # reappears -> reactivated, not duplicated
    res_r = run_import(db, make_snapshot(fixture_groups), coverage)
    assert res_r.counts["reactivated"] == 1
    assert _places(db)[("node", 1101)].active is True
    assert len(_places(db)) == len(places)


def test_T22_db_geometry_lon_lat_and_hole(db, coverage, fixture_groups, make_snapshot):
    run_import(db, make_snapshot(fixture_groups), coverage)
    with Session(db) as s:
        row = s.execute(
            text(
                "select ST_X(location::geometry), ST_Y(location::geometry), ST_GeometryType(geom), "
                "ST_NumInteriorRings(geom), ST_IsValid(geom), ST_Within(location::geometry, geom) "
                "from places where source_type='relation' and source_id=7001"
            )
        ).one()
    lon, lat, gtype, holes, valid, within = row
    assert 71.39 < lon < 71.445 and 51.075 < lat < 51.115
    assert gtype == "ST_Polygon" and holes == 1 and valid and within
    with Session(db) as s:
        lon2, lat2 = s.execute(
            text("select ST_X(location::geometry), ST_Y(location::geometry) from places where source_id=1004")
        ).one()
    assert (round(lon2, 4), round(lat2, 4)) == (71.415, 51.088)


def test_amenity_evidence_rows_and_website(db, coverage, fixture_groups, make_snapshot):
    run_import(db, make_snapshot(fixture_groups), coverage)
    with Session(db) as s:
        p = s.scalars(select(Place).where(Place.source_id == 1004)).one()
        ids = p.amenities["socket"]["evidence_ids"]
        assert len(ids) == 1
        ev = s.get(PlaceEvidence, ids[0])
        assert ev.place_id == p.id and ev.field == "socket"
        assert ev.source_url == "https://www.openstreetmap.org/node/1004"
        assert ev.source_license == "ODbL-1.0" and ev.source_value == "power_supply=yes"
        assert ev.collected_at.tzinfo is not None
        assert p.amenities["indoor"]["evidence_ids"] == []
        assert p.fetched_at.tzinfo is not None and p.source_updated_at.isoformat().startswith(
            "2025-06-01T10:00"
        )
        assert p.source_version == 1 and p.timezone == "Asia/Almaty"
        r = s.scalars(select(Place).where(Place.source_id == 1005)).one()
        assert r.website is None
        mall_cafe = s.scalars(select(Place).where(Place.source_id == 1003)).one()
        ev2 = s.get(PlaceEvidence, mall_cafe.amenities["indoor"]["evidence_ids"][0])
        assert ev2.source_value.startswith("Внутри ТРЦ SYNTH Молл")


def test_single_change_updates_only_that_record(db, coverage, fixture_groups, make_snapshot):
    run_import(db, make_snapshot(fixture_groups), coverage)
    before = _places(db)
    fixture_groups["poi_culture"][0]["tags"]["opening_hours"] = "Tu-Su 10:00-18:00"
    fixture_groups["poi_culture"][0]["version"] = 2
    res = run_import(db, make_snapshot(fixture_groups), coverage)
    assert res.counts["updated"] == 1 and res.counts["unchanged"] == len(before) - 1
    after = _places(db)
    changed = [k for k in after if after[k].content_hash != before[k].content_hash]
    assert changed == [("node", 1101)]
    assert after[("node", 1101)].updated_at > before[("node", 1101)].updated_at
    assert after[("node", 1101)].opening_hours_raw == "Tu-Su 10:00-18:00"
    assert after[("node", 1101)].id == before[("node", 1101)].id
    with Session(db) as s:
        n_oh = s.scalar(
            text("select count(*) from place_evidence where place_id=:p and field='opening_hours'"),
            {"p": after[("node", 1101)].id},
        )
    assert n_oh == 1


@pytest.mark.parametrize("bad", ["map_buildings"])
def test_missing_buildings_group_does_not_break_import(db, coverage, fixture_groups, make_snapshot, bad):
    res = run_import(db, make_snapshot(fixture_groups, failed=(bad,)), coverage)
    assert res.status == "partial" and res.counts["records"] == 11
