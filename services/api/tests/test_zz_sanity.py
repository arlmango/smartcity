"""Guards against vacuous assertions in the pipeline tests (results must be non-empty)."""

from __future__ import annotations

from conftest import body


def test_must_be_open_returns_open_places(make_client, origin, place_ids):
    c = make_client(generator=None)
    j = c.post(
        "/api/recommend", json=body(origin, time_budget_min=120, constraints={"must_be_open": True})
    ).json()
    got = {x["place_id"] for x in j["recommendations"]}
    assert got and got <= {place_ids["cafe_socket"], place_ids["xss"], place_ids["mall"]}


def test_indoor_near_returns_something(make_client, origin):
    c = make_client(generator=None)
    j = c.post("/api/recommend", json=body(origin, query="только внутри, поближе", time_budget_min=90)).json()
    assert j["recommendations"], j["message"]


def test_budget_loop_returns_cards(make_client, origin):
    c = make_client(generator=None)
    j = c.post("/api/recommend", json=body(origin, time_budget_min=30)).json()
    assert j["recommendations"]
