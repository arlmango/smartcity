"""Report numbers are computed from the DB (SYNTHETIC fixtures)."""

from __future__ import annotations

import json

from smartcity_ingest.importer import run_import
from smartcity_ingest.mapbuild import build_map
from smartcity_ingest.paths import Paths
from smartcity_ingest.report import write_reports


def test_report_counts_match_db(db, coverage, fixture_groups, make_snapshot, tmp_path):
    snap = make_snapshot(fixture_groups)
    run_import(db, snap, coverage)
    paths = Paths(data_dir=tmp_path / "data")
    build_map(snap, coverage, paths.map_dir)
    out = write_reports(db, snap, coverage, paths, docs_path=tmp_path / "DATA.md")
    m = json.loads((paths.manifests / "dataset_manifest.json").read_text())
    st = m["places"]
    assert st["active"] == 11 == out["active_places"]
    assert st["by_category"] == {
        "attraction": 1,
        "cafe": 4,
        "culture": 1,
        "food": 2,
        "mall": 1,
        "park": 1,
        "playground": 1,
    }
    assert st["generic_names"] == 1 and st["with_website"] == 1 and st["with_opening_hours"] == 1
    assert st["amenities"]["socket"] == {"true": 1, "unknown": 10}
    assert len(st["dedup_merges"]) == 1
    assert m["license"]["id"] == "ODbL-1.0" and m["snapshot"]["snapshot_hash"] == snap.snapshot_hash
    md = (tmp_path / "DATA.md").read_text()
    assert "Всего активных мест: **11**" in md and "© OpenStreetMap contributors" in md
    assert "из `height` — 1" in md
