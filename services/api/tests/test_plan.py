"""Timebox plan: pure selection rules, and the API with a SYNTHETIC router (bent L-shaped legs).

The fake router is a test double only; real geometry is checked against a live local Valhalla.
"""

import pytest
from smartcity_api.contracts import LatLon
from smartcity_api.domain.budget import haversine_m
from smartcity_api.providers.routing import RoutingError, Valhalla, _leg, minutes
from smartcity_api.services.plan import Stop, allocate_visits, category_ok, choose, plan_reachable


def table(minutes_by_pair: dict[tuple, int]):
    return lambda a, b: minutes_by_pair.get((a, b))


def sym(**pairs) -> dict[tuple, int]:
    """sym(s0=5, s1=6, d01=3): start<->0, start<->1, 0<->1 (None = start)."""
    out: dict[tuple, int] = {}
    for k, v in pairs.items():
        if k.startswith("s"):
            i = int(k[1:])
            out[(None, i)] = out[(i, None)] = v
        else:
            i, j = int(k[1]), int(k[2])
            out[(i, j)] = out[(j, i)] = v
    return out


PARK, SIGHT, CAFE = Stop("park", "park", 0), Stop("sight", "attraction", 1), Stop("cafe", "cafe", 2)


def test_allocate_visits_typical_then_shortened_then_impossible():
    assert allocate_visits(["park", "attraction"], 45) == ([30, 15], False)
    assert allocate_visits(["park", "attraction"], 20) == ([15, 5], True)  # 10+5 minimum, top up in order
    assert allocate_visits(["park", "attraction"], 14) is None


def test_exact_fit_with_zero_slack_passes_and_one_minute_less_fails():
    legs = table(sym(s0=10, s1=10, d01=5))
    # walk 25, buffer 5, minimum visits 10 + 5 -> 45 is the smallest budget with zero slack.
    best = choose([PARK, SIGHT], legs, budget=45, back=True).best
    assert best is not None and best.total_min == 45 and best.buffer_min == 5
    tight = choose([PARK, SIGHT], legs, budget=44, back=True)
    assert tight.best is None and tight.min_budget_two == 45


def test_return_leg_counted_only_when_requested():
    legs = table(sym(s0=10, s1=10, d01=5))
    there = choose([PARK, SIGHT], legs, budget=60, back=False).best
    loop = choose([PARK, SIGHT], legs, budget=60, back=True).best
    assert there is not None and loop is not None
    assert there.walk_min == 15 and loop.walk_min == 25
    assert loop.total_min <= 60 and there.total_min <= 60


def test_missing_leg_never_bridged():
    legs = sym(s0=5, s1=5, d01=3)
    del legs[(0, 1)], legs[(1, 0)]
    assert choose([PARK, SIGHT], table(legs), budget=120, back=True).best is None


def test_one_eating_stop_and_category_cap():
    assert not category_ok(["cafe", "food"]) and not category_ok(["park", "park", "park"])
    assert category_ok(["park", "park", "cafe"])
    cafe2 = Stop("cafe2", "cafe", 1)
    legs = table(sym(s0=3, s1=3, d01=2))
    assert choose([CAFE, cafe2], legs, budget=180, back=True).best is None


def test_three_stops_preferred_when_they_fit_and_result_is_deterministic():
    stops = [PARK, SIGHT, CAFE]
    pairs = sym(s0=5, s1=6, s2=7, d01=3, d02=4, d12=3)
    a = choose(stops, table(pairs), budget=120, back=True).best
    b = choose(stops, table(pairs), budget=120, back=True).best
    assert a is not None and b is not None and a.order == b.order and len(a.order) == 3
    assert a.total_min <= 120 and a.arrive[0] == pairs[(None, a.order[0])]


def test_closed_stop_is_not_planned():
    legs = table(sym(s0=5, s1=5, s2=5, d01=2, d02=2, d12=2))
    best = choose([PARK, SIGHT, CAFE], legs, budget=120, back=True, open_ok=lambda i, a, v: i != 2).best
    assert best is not None and 2 not in best.order


def test_contradictory_request_has_no_plan():
    # 15 minutes, return to start, three far places: impossible, and the planner says so.
    legs = table(sym(s0=20, s1=25, s2=30, d01=10, d02=10, d12=10))
    out = choose([PARK, SIGHT, CAFE], legs, budget=15, back=True)
    assert out.best is None and out.min_budget_two is not None and out.min_budget_two > 15


def test_plan_reachable_threshold():
    from smartcity_api.domain.budget import TimingCalc

    assert plan_reachable(TimingCalc(18, 10, 18, 5, 51), 60)  # 36 <= 36
    assert not plan_reachable(TimingCalc(19, 10, 18, 5, 52), 60)


# ------------------------------------------------------------------ API with a synthetic router


def bent_leg(a: LatLon, b: LatLon) -> dict:
    corner = (b.lon, a.lat)
    length = haversine_m(a.lat, a.lon, a.lat, b.lon) + haversine_m(a.lat, b.lon, b.lat, b.lon)
    coords = [(a.lon, a.lat), corner, (b.lon, b.lat)]
    return {
        "shape": {"type": "LineString", "coordinates": coords},
        "summary": {"length": length / 1000, "time": length / (4000 / 3600)},
    }


def fake_legs(self, points, *, timeout=2.0):
    return [_leg(bent_leg(p, q), p, q) for p, q in zip(points, points[1:], strict=False)]


@pytest.fixture
def routed(make_client, monkeypatch):
    from smartcity_api.contracts import WalkingRoute

    def fake_route(self, start, end, back, *, timeout=2.0):
        legs = fake_legs(self, [start, end, start] if back else [start, end])
        return WalkingRoute(
            graph_version="synthetic-test",
            outbound=legs[0],
            return_leg=legs[1] if back else None,
            note="SYNTHETIC",
        )

    monkeypatch.setattr(Valhalla, "legs", fake_legs)
    monkeypatch.setattr(Valhalla, "route", fake_route)
    return make_client(routing_provider="valhalla", routing_base_url="http://localhost:8208")


def test_plan_uses_db_places_router_legs_and_fits_budget(routed, origin, place_ids, engine):
    from conftest import body

    res = routed.post("/api/recommend", json=body(origin, query="погулять", time_budget_min=90)).json()
    plan = res["plan"]
    assert plan is not None, res.get("plan_note")
    known = set(place_ids.values())
    assert all(s["place_id"] in known for s in plan["stops"])
    assert plan["total_min"] == plan["walk_min"] + plan["visit_min"] + plan["buffer_min"] <= 90
    legs = [s["leg_in"] for s in plan["stops"]] + [plan["return_leg"]]
    assert plan["walk_min"] == sum(minutes(_as_leg(x)) for x in legs)
    assert plan["distance_m"] == sum(x["distance_m"] for x in legs)
    # Every leg is the router's bent line, never a straight start-end segment.
    assert all(len(x["geometry"]["coordinates"]) == 3 for x in legs)
    # Arrival time = previous arrival + visit + leg.
    clock = 0
    for s in plan["stops"]:
        clock += minutes(_as_leg(s["leg_in"]))
        assert s["arrive_min"] == clock
        clock += s["visit_min"]
    # Name and coordinates come from the DB row.
    from sqlalchemy import text

    with engine.connect() as cx:
        for s in plan["stops"]:
            row = cx.execute(
                text("select name, ST_Y(geom::geometry), ST_X(geom::geometry) from places where id = :i"),
                {"i": s["place_id"]},
            ).one()
            assert (row[0], round(row[1], 6), round(row[2], 6)) == (
                s["name"],
                round(s["coordinates"]["lat"], 6),
                round(s["coordinates"]["lon"], 6),
            )
    assert plan["why"] and "SYNTHETIC" not in " ".join(plan["why"])


def test_remove_stop_recomputes_without_it(routed, origin):
    from conftest import body

    first = routed.post("/api/recommend", json=body(origin, query="погулять", time_budget_min=90)).json()[
        "plan"
    ]
    gone = first["stops"][0]["place_id"]
    again = routed.post(
        "/api/recommend",
        json=body(origin, query="погулять", time_budget_min=90, constraints={"exclude_place_ids": [gone]}),
    ).json()
    assert all(c["place_id"] != gone for c in again["recommendations"])
    if again["plan"]:
        assert gone not in [s["place_id"] for s in again["plan"]["stops"]]
    else:
        assert again["plan_note"]


def test_small_budget_gives_note_not_plan(routed, origin):
    from conftest import body

    res = routed.post("/api/recommend", json=body(origin, query="погулять", time_budget_min=25)).json()
    assert res["plan"] is None
    if res["recommendations"]:
        assert res["plan_note"]


def test_pair_router_failure_drops_whole_plan_but_keeps_cards(routed, origin, monkeypatch):
    from conftest import body

    def broken(self, points, *, timeout=2.0):
        raise RoutingError("unavailable")

    monkeypatch.setattr(Valhalla, "legs", broken)
    res = routed.post("/api/recommend", json=body(origin, query="погулять", time_budget_min=90)).json()
    assert res["plan"] is None and "не построен" in res["plan_note"]
    assert res["recommendations"]


def test_no_router_means_no_plan(make_client, origin):
    from conftest import body

    res = make_client().post("/api/recommend", json=body(origin, time_budget_min=90)).json()
    assert res["plan"] is None
    assert res["recommendations"] and "пешеходному графу" in res["plan_note"]


def test_injected_description_and_invented_ids_do_not_reach_plan(routed, origin, place_ids, make_client):
    from conftest import body
    from fakes import FakeGeneration

    invented = '{"selected": [{"place_id": "evil-1", "reason": "x", "activity": null}], "summary": "x"}'
    gen = FakeGeneration([invented, invented, invented])
    client = make_client(generator=gen, routing_provider="valhalla", routing_base_url="http://localhost:8208")
    res = client.post(
        "/api/recommend", json=body(origin, query="фонтан инструкция", time_budget_min=90)
    ).json()
    known = set(place_ids.values())
    assert all(c["place_id"] in known for c in res["recommendations"])
    if res["plan"]:
        assert all(s["place_id"] in known for s in res["plan"]["stops"])


def _as_leg(raw: dict):
    from smartcity_api.contracts import RouteLeg

    return RouteLeg.model_validate(raw)
