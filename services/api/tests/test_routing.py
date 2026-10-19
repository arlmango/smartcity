"""Synthetic protocol tests use a bent polyline, never a straight fallback path."""

import math
from types import SimpleNamespace

import httpx
import pytest
import respx
from smartcity_api.contracts import LatLon
from smartcity_api.providers.routing import RoutingError, Valhalla, decode_shape, minutes
from smartcity_api.services.routing import route_candidates

A = LatLon(lat=51.0889, lon=71.4152)
B = LatLon(lat=51.0935, lon=71.4175)


def response():
    outward = [[A.lon, A.lat], [71.4152, 51.092], [71.4175, 51.092], [B.lon, B.lat]]
    backward = [[B.lon, B.lat], [71.419, 51.092], [71.419, 51.0889], [A.lon, A.lat]]
    return {
        "trip": {
            "status": 0,
            "legs": [
                {
                    "shape": {"type": "LineString", "coordinates": outward},
                    "summary": {"length": 0.8, "time": 720},
                },
                {
                    "shape": {"type": "LineString", "coordinates": backward},
                    "summary": {"length": 1.1, "time": 1000},
                },
            ],
        }
    }


@respx.mock
def test_asymmetric_route_and_payload():
    mock = respx.post("http://localhost:8208/route").mock(return_value=httpx.Response(200, json=response()))
    provider = Valhalla("http://localhost:8208")
    route = provider.route(A, B, True)
    provider.close()
    assert route.outbound.distance_m == 800
    assert minutes(route.outbound) == 12
    assert minutes(route.return_leg) == 17
    assert route.return_leg.geometry.coordinates != list(reversed(route.outbound.geometry.coordinates))
    import json

    sent = json.loads(mock.calls[0].request.content)
    assert sent["locations"][0] == sent["locations"][2]
    assert sent["costing_options"]["pedestrian"]["walking_speed"] == 4


@pytest.mark.parametrize("mutation", ["nan", "empty", "far_snap", "outside_geometry", "missing_leg"])
@respx.mock
def test_malformed_or_unverified_never_returns_line(mutation):
    data = response()
    leg = data["trip"]["legs"][0]
    if mutation == "nan":
        leg["summary"]["time"] = -1
    elif mutation == "empty":
        leg["shape"]["coordinates"] = []
    elif mutation == "far_snap":
        leg["shape"]["coordinates"][0] = [71.42, 51.09]
    elif mutation == "outside_geometry":
        leg["shape"]["coordinates"][1] = [71.6, 51.2]
    else:
        data["trip"]["legs"].pop()
    respx.post("http://localhost:8208/route").mock(return_value=httpx.Response(200, json=data))
    provider = Valhalla("http://localhost:8208")
    with pytest.raises(RoutingError):
        provider.route(A, B, True)
    provider.close()


@pytest.mark.parametrize("status,code,expected", [(400, 442, "no_path"), (500, 500, "unavailable")])
@respx.mock
def test_provider_failure(status, code, expected):
    respx.post("http://localhost:8208/route").mock(
        return_value=httpx.Response(status, json={"error_code": code})
    )
    provider = Valhalla("http://localhost:8208")
    with pytest.raises(RoutingError, match=expected):
        provider.route(A, B, True)
    provider.close()


@respx.mock
def test_timeout_and_outside_and_external():
    mocked = respx.post("http://localhost:8208/route").mock(side_effect=httpx.ReadTimeout("timeout"))
    provider = Valhalla("http://localhost:8208")
    with pytest.raises(RoutingError, match="outside_coverage"):
        provider.route(LatLon(lat=52, lon=72), B, False)
    assert not mocked.called
    with pytest.raises(RoutingError, match="unavailable"):
        provider.route(A, B, False)
    provider.close()
    with pytest.raises(RoutingError, match="not_local"):
        Valhalla("https://example.com")


@pytest.mark.parametrize("shape", ["?", "\x00", "_" * 20])
def test_polyline_malformed(shape):
    with pytest.raises(RoutingError):
        decode_shape(shape)


@respx.mock
def test_same_point_real_router_geometry():
    data = response()
    for leg in data["trip"]["legs"]:
        leg["shape"]["coordinates"] = [[A.lon, A.lat], [A.lon, A.lat]]
        leg["summary"] = {"length": 0, "time": 0}
    respx.post("http://localhost:8208/route").mock(return_value=httpx.Response(200, json=data))
    provider = Valhalla("http://localhost:8208")
    route = provider.route(A, A, True)
    provider.close()
    assert minutes(route.outbound) == 0 and route.outbound.distance_m == 0


@respx.mock
def test_partial_failure_discards_routes_and_does_not_claim_provider():
    import threading
    import time

    respx.post("http://localhost:8208/route").mock(
        side_effect=[httpx.Response(200, json=response()), httpx.ConnectError("down")]
    )
    container = SimpleNamespace(
        settings=SimpleNamespace(routing_provider="valhalla", routing_base_url="http://localhost:8208")
    )
    prep = SimpleNamespace(
        deadline=time.monotonic() + 10,
        req=SimpleNamespace(origin=A),
        eff=SimpleNamespace(return_to_start=True),
        warnings=[],
        timings={},
        routing_ok=False,
        cancelled=threading.Event(),
    )
    pool = [
        SimpleNamespace(
            place=SimpleNamespace(lat=B.lat, lon=B.lon), route=None, routing_exclusion=None, distance_m=1
        )
        for _ in range(2)
    ]
    route_candidates(container, prep, pool)
    assert all(c.route is None and c.distance_m > 100 for c in pool)
    assert not prep.routing_ok and prep.warnings[0].code == "routing_unavailable"


def test_recommend_route_budget_and_prompt(make_client, origin, monkeypatch):
    from conftest import body, gen_ok
    from smartcity_api.contracts import WalkingRoute
    from smartcity_api.providers.routing import _leg

    r = WalkingRoute(
        graph_version="synthetic-test",
        outbound=_leg(response()["trip"]["legs"][0], A, B),
        return_leg=_leg(response()["trip"]["legs"][1], B, A),
        note="SYNTHETIC routing fixture",
    )
    monkeypatch.setattr(Valhalla, "route", lambda *args, **kw: r)
    gen = gen_ok(["Учебный"])
    client = make_client(generator=gen, routing_provider="valhalla", routing_base_url="http://localhost:8208")
    result = client.post("/api/recommend", json=body(origin, query="погулять")).json()
    assert result["recommendations"]
    for card in result["recommendations"]:
        assert card["timing"]["outbound_min"] == 12
        assert card["timing"]["return_min"] == 17
        assert card["timing"]["total_min"] <= 60
        assert card["route"] is not None and card["distance"]["method"] == "pedestrian_route"
    assert result["providers"]["routing"] == "valhalla"
    assert "straight_line_estimate" not in [w["code"] for w in result["warnings"]]
    assert "pedestrian_route" in gen.calls[0]["user"]
    result = client.post("/api/recommend", json=body(origin, time_budget_min=20)).json()
    assert result["status"] == "no_match" and not result["recommendations"]


def test_no_path_is_excluded(make_client, origin, monkeypatch):
    from conftest import body

    def fail(*args, **kw):
        raise RoutingError("no_path")

    monkeypatch.setattr(Valhalla, "route", fail)
    client = make_client(routing_provider="valhalla", routing_base_url="http://localhost:8208")
    result = client.post("/api/recommend", json=body(origin)).json()
    assert not result["recommendations"] and result["status"] == "no_match"
    assert not result["suggested_relaxations"]
    assert "routing_excluded" in [w["code"] for w in result["warnings"]]


def test_endpoint_coverage_and_unavailable(make_client):
    client = make_client(routing_provider="valhalla", routing_base_url="http://localhost:8208")
    result = client.post("/api/route", json={"origin": {"lat": 52, "lon": 72}, "destination": B.model_dump()})
    assert result.status_code == 422 and result.json()["error"] == "routing_outside_coverage"
    with respx.mock:
        respx.post("http://localhost:8208/route").mock(side_effect=httpx.ConnectError("down"))
        result = client.post("/api/route", json={"origin": A.model_dump(), "destination": B.model_dump()})
        assert result.status_code == 503


@pytest.mark.parametrize(
    "lat,lon", [(51.0938897, 71.4178709794), (51.0934498, 71.4175646252), (51.08908605, 71.4072859297)]
)
def test_live_local_control(lat, lon):
    import os

    if os.environ.get("RUN_ROUTING_LIVE") != "1":
        pytest.skip("set RUN_ROUTING_LIVE=1 for local public EXPO graph controls")
    from smartcity_api.domain.budget import haversine_m

    provider = Valhalla("http://127.0.0.1:8208")
    destination = LatLon(lat=lat, lon=lon)
    route = provider.route(A, destination, True)
    provider.close()
    assert len(route.outbound.geometry.coordinates) > 20
    assert route.outbound.distance_m > haversine_m(A.lat, A.lon, lat, lon) * 1.1
    assert route.return_leg is not None and len(route.return_leg.geometry.coordinates) > 20
    assert route.outbound.start_snap_m <= 100 and route.outbound.end_snap_m <= 100
    assert minutes(route.outbound) >= math.ceil(route.outbound.duration_s / 60)


def test_live_samepoint():
    import os

    if os.environ.get("RUN_ROUTING_LIVE") != "1":
        pytest.skip("set RUN_ROUTING_LIVE=1 for local public EXPO graph controls")
    provider = Valhalla("http://127.0.0.1:8208")
    route = provider.route(A, A, True)
    provider.close()
    assert route.outbound.distance_m == 0 and minutes(route.outbound) == 0
    assert route.return_leg is not None and minutes(route.return_leg) == 0


def test_max_distance_constraint_remains_geodesic():
    from smartcity_api.domain.constraints import Effective
    from smartcity_api.services.recommend import Candidate, hard_exclusion

    candidate = Candidate(
        place=SimpleNamespace(pid="synthetic", name="SYNTHETIC", category="park"),
        distance_m=700,
        geodesic_distance_m=400,
        features=None,
    )
    assert (
        hard_exclusion(
            candidate, Effective(time_budget_min=60, return_to_start=True, max_distance_m=(500, "ui"))
        )
        is None
    )
    candidate.geodesic_distance_m = 501
    assert (
        hard_exclusion(
            candidate, Effective(time_budget_min=60, return_to_start=True, max_distance_m=(500, "ui"))
        )
        == "max_distance"
    )


def test_deadline_does_not_start_route_and_returns_estimate(monkeypatch):
    import threading
    import time

    calls = []
    monkeypatch.setattr(Valhalla, "route", lambda *args, **kwargs: calls.append(args))
    container = SimpleNamespace(
        settings=SimpleNamespace(routing_provider="valhalla", routing_base_url="http://localhost:8208")
    )
    prep = SimpleNamespace(
        deadline=time.monotonic() - 1,
        req=SimpleNamespace(origin=A),
        eff=SimpleNamespace(return_to_start=True),
        warnings=[],
        timings={},
        routing_ok=False,
        cancelled=threading.Event(),
    )
    pool = [
        SimpleNamespace(
            place=SimpleNamespace(lat=B.lat, lon=B.lon), route=None, routing_exclusion=None, distance_m=1
        )
    ]
    route_candidates(container, prep, pool)
    assert not calls and pool[0].route is None and prep.warnings[0].code == "routing_unavailable"
    prep.cancelled.set()
    from smartcity_api.errors import ClientDisconnected

    with pytest.raises(ClientDisconnected):
        route_candidates(container, prep, pool)
    assert not calls


def test_nonzero_access_is_added_to_each_leg_budget():
    from datetime import UTC, datetime

    from smartcity_api.contracts import WalkingRoute
    from smartcity_api.domain.constraints import Effective
    from smartcity_api.providers.routing import _leg
    from smartcity_api.services.recommend import Candidate, schedule_exclusion

    # Synthetic endpoints are ~44.5 m north of each network endpoint: combined
    # approach is ~89 m, which rounds UP to two minutes independently per leg.
    start = LatLon(lat=A.lat + 0.0004, lon=A.lon)
    end = LatLon(lat=B.lat + 0.0004, lon=B.lon)
    raw = response()
    outbound = _leg(raw["trip"]["legs"][0], start, end)
    returning = _leg(raw["trip"]["legs"][1], end, start)
    assert outbound.start_snap_m == outbound.end_snap_m == 45
    assert outbound.access_estimate_min == returning.access_estimate_min == 2
    assert minutes(outbound) == 14 and minutes(returning) == 19
    route = WalkingRoute(
        graph_version="synthetic-test", outbound=outbound, return_leg=returning, note="SYNTHETIC access test"
    )
    candidate = Candidate(
        place=SimpleNamespace(category="park", opening_hours_raw=None),
        distance_m=800,
        features=None,
        route=route,
    )
    start_time = datetime(2026, 10, 19, 12, tzinfo=UTC)
    eff = Effective(time_budget_min=60, return_to_start=True)
    assert schedule_exclusion(candidate, eff, start_time, 66.7, 1.3) is None
    assert candidate.timing.outbound_min == 14 and candidate.timing.return_min == 19
    assert candidate.timing.total_min == 14 + 19 + candidate.timing.visit_min + candidate.timing.buffer_min
    # Even before a visit, route + both approaches + buffer exceeds 33 minutes.
    eff.time_budget_min = 33
    assert schedule_exclusion(candidate, eff, start_time, 66.7, 1.3) == "budget"


def test_call_limit_discards_all_256_partial_routes_on_257th_candidate(monkeypatch):
    import threading
    from unittest.mock import Mock

    from smartcity_api.domain.budget import haversine_m
    from smartcity_api.services import routing

    # Freeze the clock so this test exercises the call limit, not the deadline.
    monkeypatch.setattr(routing.time, "monotonic", lambda: 100.0)
    fake_route = SimpleNamespace(outbound=SimpleNamespace(distance_m=800))
    call = Mock(return_value=fake_route)
    monkeypatch.setattr(Valhalla, "route", call)
    container = SimpleNamespace(
        settings=SimpleNamespace(routing_provider="valhalla", routing_base_url="http://localhost:8208")
    )
    prep = SimpleNamespace(
        deadline=120.0,
        req=SimpleNamespace(origin=A),
        eff=SimpleNamespace(return_to_start=True),
        warnings=[],
        timings={},
        routing_ok=False,
        cancelled=threading.Event(),
    )
    pool = [
        SimpleNamespace(
            place=SimpleNamespace(lat=B.lat, lon=B.lon), route=None, routing_exclusion=None, distance_m=1
        )
        for _ in range(257)
    ]
    route_candidates(container, prep, pool)
    assert call.call_count == 256
    assert all(c.route is None and c.routing_exclusion is None for c in pool)
    direct = haversine_m(A.lat, A.lon, B.lat, B.lon)
    assert all(c.distance_m == direct for c in pool)
    assert not prep.routing_ok
    assert [w.code for w in prep.warnings] == ["routing_unavailable"]
