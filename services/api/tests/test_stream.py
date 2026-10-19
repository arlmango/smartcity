"""POST /api/recommend/stream: places found by retrieval are sent before generation finishes and
survive a model timeout (fake providers, synthetic DB)."""

from __future__ import annotations

import json

from conftest import body, gen_ok
from fakes import FakeGeneration
from smartcity_api.providers.base import ProviderTimeout


def events(c, b) -> list[dict]:
    with c.stream("POST", "/api/recommend/stream", json=b) as r:
        assert r.status_code == 200 and r.headers["content-type"].startswith("application/x-ndjson")
        return [json.loads(line) for line in r.iter_lines() if line.strip()]


def test_preliminary_cards_precede_final_live_answer(make_client, origin):
    c = make_client(generator=gen_ok(["Учебный"]))
    ev = events(c, body(origin, query="погулять в сквере"))
    assert [e["event"] for e in ev] == ["preliminary", "final"]
    pre, fin = ev[0]["response"], ev[1]["response"]
    assert pre["recommendations"] and pre["mode"] == "retrieval_only"
    assert "ai_pending" in [w["code"] for w in pre["warnings"]]
    assert all(r["reason"] is None for r in pre["recommendations"])  # no text before the model answers
    assert fin["mode"] == "live_rag" and fin["client_request_id"] == pre["client_request_id"]


def test_model_timeout_keeps_the_found_places(make_client, origin):
    c = make_client(generator=FakeGeneration([ProviderTimeout("t")]))
    ev = events(c, body(origin, query="погулять"))
    assert [e["event"] for e in ev] == ["preliminary", "final"]
    pre_ids = [r["place_id"] for r in ev[0]["response"]["recommendations"]]
    fin = ev[1]["response"]
    assert fin["mode"] == "retrieval_only" and "llm_unavailable" in [w["code"] for w in fin["warnings"]]
    assert [r["place_id"] for r in fin["recommendations"]] == pre_ids


def test_no_match_has_only_a_final_event(make_client, origin):
    c = make_client(generator=None)
    ev = events(c, body({"lat": 51.0785, "lon": 71.3955}, time_budget_min=10))
    assert [e["event"] for e in ev] == ["final"] and ev[0]["response"]["status"] == "no_match"


def test_stream_validation_error_is_plain_422(make_client, origin):
    c = make_client(generator=None)
    r = c.post("/api/recommend/stream", json=body(origin, time_budget_min=5))
    assert r.status_code == 422 and r.json()["error"] == "validation_error"


def test_stream_shares_the_recommend_rate_limit(make_client, origin):
    c = make_client(generator=None, rate_limit="1/minute")
    b = body(origin, origin={"lat": 10.0, "lon": 10.0})
    assert c.post("/api/recommend/stream", json=b).status_code == 200
    assert c.post("/api/recommend", json=b).status_code == 429
