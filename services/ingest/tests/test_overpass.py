"""Overpass client policy tests with a mock transport (no network)."""

from __future__ import annotations

import json
from urllib.parse import unquote_plus

import httpx
import pytest
from smartcity_ingest.overpass import OverpassClient, OverpassError, build_query, query_groups
from smartcity_ingest.snapshot import fetch_snapshot, load_snapshot


def _is_roads(req) -> bool:
    return 'way["highway"]' in unquote_plus(req.content.decode())


OK = {"version": 0.6, "osm3s": {"timestamp_osm_base": "2025-06-01T12:00:00Z"}, "elements": []}


def _client(handler, sleeps):
    return OverpassClient(
        "https://overpass.example/api/interpreter",
        "SmartCity-test/0.1",
        transport=httpx.MockTransport(handler),
        sleep=sleeps.append,
    )


def test_bounded_retries_then_error():
    calls, sleeps = [], []

    def h(req):
        calls.append(req)
        return httpx.Response(504, text="<html>504</html>")

    c = _client(h, sleeps)
    with pytest.raises(OverpassError):
        c.run("[out:json];node(1);out;")
    assert len(calls) == 3  # max 3 attempts
    assert calls[0].headers["User-Agent"] == "SmartCity-test/0.1"
    assert calls[0].method == "POST"


def test_runtime_error_html_and_remark_are_failures():
    sleeps = []
    responses = iter(
        [
            httpx.Response(200, text="<html>runtime error: Dispatcher_Client timeout</html>"),
            httpx.Response(200, json={**OK, "remark": 'runtime error: Query timed out in "query"'}),
            httpx.Response(200, json=OK),
        ]
    )
    c = _client(lambda req: next(responses), sleeps)
    res = c.run("q")
    assert res.attempts == 3 and res.data["elements"] == []
    assert 10.0 in sleeps and 30.0 in sleeps  # backoff between attempts (plus >=2 s pacing)


def test_non_retryable_400():
    calls = []

    def h(req):
        calls.append(1)
        return httpx.Response(400, text="bad query")

    with pytest.raises(OverpassError):
        _client(h, []).run("q")
    assert len(calls) == 1


def test_https_only():
    with pytest.raises(ValueError):
        OverpassClient("http://insecure.example", "ua")


def test_fetch_snapshot_partial(tmp_path, coverage):
    def h(req):
        if _is_roads(req):
            return httpx.Response(504)
        return httpx.Response(200, json=OK)

    c = _client(h, [])
    snap = fetch_snapshot(
        c, query_groups(), coverage, tmp_path, endpoint="https://overpass.example", user_agent="ua"
    )
    assert snap.manifest["status"] == "partial" and not snap.complete
    assert snap.manifest["groups"]["map_roads"]["status"] == "failed"
    assert snap.manifest["osm_base_timestamp"] == "2025-06-01T12:00:00Z"
    again = load_snapshot(snap.path)
    assert again.snapshot_hash == snap.snapshot_hash
    m = json.loads((snap.path / "snapshot.json").read_text())
    assert "poly:" in m["queries"]["poi_cafe_food"]


def test_query_uses_coverage_poly_lat_lon(coverage):
    q = build_query(query_groups()[0], coverage.overpass_poly())
    assert '(poly:"51.075000 71.390000' in q and q.startswith("[out:json][timeout:")
    assert "out meta geom;" in q


def test_relation_groups_request_members():
    # `out tags` drops relation members -> multipolygons could not be assembled (regression guard)
    for g in query_groups():
        may_have_relations = any(s.startswith(("relation", "nwr")) for s in g.selectors)
        if may_have_relations and "center" not in g.output:
            assert "body" in g.output or "meta" in g.output, g.name


def test_retry_failed_groups_completes_snapshot(tmp_path, coverage):
    from smartcity_ingest.snapshot import retry_failed_groups

    def flaky(req):
        if _is_roads(req):
            return httpx.Response(504)
        return httpx.Response(200, json=OK)

    snap = fetch_snapshot(
        _client(flaky, []), query_groups(), coverage, tmp_path, endpoint="https://o.example", user_agent="ua"
    )
    kept = {k: v["sha256"] for k, v in snap.manifest["groups"].items() if v["status"] == "ok"}
    calls = []

    def ok(req):
        calls.append(unquote_plus(req.content.decode()))
        return httpx.Response(200, json=OK)

    snap2 = retry_failed_groups(_client(ok, []), snap, query_groups(), coverage)
    assert snap2.complete and snap2.manifest["status"] == "complete"
    assert len(calls) == 1 and 'way["highway"]' in calls[0]  # only the failed group is re-fetched
    assert {k: snap2.manifest["groups"][k]["sha256"] for k in kept} == kept
    assert snap2.manifest["groups"]["map_roads"]["previous_failures"][0]["error"] == "HTTP 504"
    assert load_snapshot(snap2.path).complete
