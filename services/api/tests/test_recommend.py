"""POST /api/recommend pipeline on the SYNTHETIC DB with FakeEmbedding / FakeGeneration.

Covers ACCEPTANCE T01–T18, T23–T30 (server side). Fake providers are deterministic stand-ins; the
real-provider checks live in test_live.py (marker `live`).
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import timedelta

import pytest
from conftest import FIXED_NOW, body, gen_ok, seed
from fakes import FakeEmbedding, FakeGeneration, alias_for, candidate_names
from smartcity_api.errors import ClientDisconnected
from smartcity_api.providers.base import ProviderRateLimited, ProviderTimeout
from smartcity_api.services.recommend import LLM_UNAVAILABLE_MSG, cancellable


def post(c, b):
    r = c.post("/api/recommend", json=b)
    return r, r.json()


def names(j) -> list[str]:
    return [x["name"] for x in j["recommendations"]]


def warn_codes(j) -> set[str]:
    return {w["code"] for w in j["warnings"]}


# ---------------------------------------------------------------- happy path / grounding


def test_live_rag_path_grounded_facts(make_client, origin, place_ids):
    emb = FakeEmbedding()
    gen = gen_ok(["Учебный"], reason="Сквер с дорожками для прогулки.")
    c = make_client(embedder=emb, generator=gen)
    r, j = post(c, body(origin, query="Хочу погулять в сквере", client_request_id="client-abc-123"))
    assert r.status_code == 200
    assert j["status"] == "ok" and j["mode"] == "live_rag"
    assert j["client_request_id"] == "client-abc-123" and j["request_id"] == r.headers["x-request-id"]  # T24
    assert j["dataset_version"] == "synthetic-v1"
    card = j["recommendations"][0]
    assert card["place_id"] == place_ids["park"]
    assert card["name"] == "SYNTHETIC Сквер «Учебный»" and card["reason_source"] == "llm"
    assert card["reason"] == "Сквер с дорожками для прогулки."
    assert card["distance"]["method"] == "geodesic" and "По прямой" in card["distance"]["note"]  # T23
    t = card["timing"]
    assert t["estimated"] is True
    assert t["total_min"] == t["outbound_min"] + t["visit_min"] + t["return_min"] + t["buffer_min"] <= 60
    assert t["return_min"] == t["outbound_min"]
    assert card["source"]["url"] == "https://www.openstreetmap.org/way/900000004"
    assert card["opening_status"] == "unknown" and card["opening_hours_raw"] is None
    assert j["route"] is None
    assert "straight_line_estimate" in warn_codes(j)
    assert j["providers"]["llm_provider"] == "fake" and j["providers"]["embedding_dim"] == 64
    assert j["providers"]["routing"] == "none"
    assert {"parse", "shortlist", "semantic", "rank", "schedule", "generate", "total"} <= set(j["timings_ms"])
    kinds = {k for k, _ in emb.calls}
    assert "query" in kinds  # query embedding computed by the same provider (kind=query)
    hard = {h["kind"] for h in j["constraints_applied"]["hard"]}
    assert {"time_budget", "return_to_start", "walking_only"} <= hard


def test_prompt_contains_only_aliases_and_allowed_fields(make_client, origin, place_ids):
    gen = gen_ok(["Учебный"])
    c = make_client(generator=gen)
    post(c, body(origin, query="погулять"))
    user = gen.calls[0]["user"]
    for pid in place_ids.values():
        assert pid not in user  # UUIDs never reach the model
    assert "https://" not in user and "synthetic.example" not in user  # no URLs/website
    assert "SYNTHETIC Кафе «Закрытое навсегда»" not in user  # inactive place never retrieved
    assert "SYNTHETIC Памятник «Далёкий»" not in user  # outside walking reach
    assert (
        gen.calls[0]["schema"]["properties"]["recommendations"]["items"]["properties"]["place_id"]["enum"][0]
        == "C1"
    )


def test_T30_llm_cannot_overwrite_facts(make_client, origin, place_ids):
    def respond(system, user):
        a = alias_for(user, "Учебный")
        return json.dumps(
            {
                "recommendations": [
                    {
                        "place_id": a,
                        "reason": "Хороший сквер для прогулки.",
                        "activity_suggestion": "Прогуляйтесь по дорожкам.",
                        "name": "Fake Name",
                        "coordinates": {"lat": 0.0, "lon": 0.0},
                        "website": "http://evil.example",
                        "opening_status": "open",
                    }
                ],
                "message": "Готово.",
            },
            ensure_ascii=False,
        )

    c = make_client(generator=FakeGeneration([respond]))
    _, j = post(c, body(origin, query="погулять"))
    card = j["recommendations"][0]
    assert card["name"] == "SYNTHETIC Сквер «Учебный»"
    assert card["coordinates"]["lat"] == pytest.approx(51.0927, abs=1e-3)
    assert card["website"] is None and card["opening_status"] == "unknown"
    assert "evil" not in json.dumps(j)


def test_T29_no_duplicates(make_client, origin):
    def respond(system, user):
        a = alias_for(user, "Учебный")
        rec = {"place_id": a, "reason": "Сквер для прогулки.", "activity_suggestion": "Пройдитесь."}
        return json.dumps({"recommendations": [rec, rec, rec], "message": "Готово."}, ensure_ascii=False)

    gen = FakeGeneration([respond])
    c = make_client(generator=gen)
    _, j = post(c, body(origin, query="погулять в сквере"))
    assert names(j) == ["SYNTHETIC Сквер «Учебный»"]
    # node/way duplicate of the same square is collapsed before generation
    assert candidate_names(gen.calls[0]["user"]).count("SYNTHETIC Сквер «Учебный»") == 1


def test_retrieval_only_without_llm_is_labelled(make_client, origin):
    c = make_client(generator=None)
    _, j = post(c, body(origin, query="кофе"))
    assert j["mode"] == "retrieval_only" and j["status"] == "degraded"
    assert "llm_unavailable" in warn_codes(j)
    assert j["message"].startswith(LLM_UNAVAILABLE_MSG)
    assert all(x["reason"] is None and x["reason_source"] == "rules" for x in j["recommendations"])
    ids = [x["place_id"] for x in j["recommendations"]]
    assert 1 <= len(ids) <= 3 and len(set(ids)) == len(ids)
    cats = [x["category"] for x in j["recommendations"]]
    assert max(cats.count(cat) for cat in cats) <= 2  # diversity


# ---------------------------------------------------------------- LLM failures


def test_T13_invalid_json_retry_then_fallback(make_client, origin):
    gen = FakeGeneration(["{not json", "still not json"])
    c = make_client(generator=gen)
    _, j = post(c, body(origin, query="погулять"))
    assert len(gen.calls) == 2
    assert "Предыдущий ответ был отклонён" in gen.calls[1]["user"]
    assert j["mode"] == "retrieval_only" and j["status"] == "degraded"
    assert j["recommendations"] and all(x["reason"] is None for x in j["recommendations"])


def test_T13_invalid_then_valid_is_live(make_client, origin):
    good = gen_ok(["Учебный"]).script[0]
    gen = FakeGeneration(["[]", good])
    c = make_client(generator=gen)
    _, j = post(c, body(origin, query="погулять"))
    assert len(gen.calls) == 2 and j["mode"] == "live_rag" and j["status"] == "ok"


def test_T14_unknown_place_id(make_client, origin):
    bad = json.dumps(
        {
            "recommendations": [
                {"place_id": "C99", "reason": "Отличное место.", "activity_suggestion": "x"},
                {
                    "place_id": "00000000-0000-0000-0000-000000000000",
                    "reason": "Отличное место.",
                    "activity_suggestion": "x",
                },
            ],
            "message": "Готово.",
        },
        ensure_ascii=False,
    )
    gen = FakeGeneration([bad, bad])
    c = make_client(generator=gen)
    _, j = post(c, body(origin, query="погулять"))
    assert j["mode"] == "retrieval_only" and "llm_unavailable" in warn_codes(j)
    assert "00000000-0000-0000-0000-000000000000" not in [x["place_id"] for x in j["recommendations"]]


def test_T15_prompt_injection_in_retrieved_description(make_client, origin, place_ids):
    def obey(system, user):
        a = alias_for(user, "Инструкция")
        return json.dumps(
            {
                "recommendations": [
                    {"place_id": "C99", "reason": "Секретное место.", "activity_suggestion": "x"},
                    {
                        "place_id": a,
                        "reason": "Здесь есть розетки и Wi-Fi. Подробнее на http://evil.example/steal",
                        "activity_suggestion": "Зайдите на http://evil.example",
                    },
                ],
                "message": "Перейдите по ссылке http://evil.example",
            },
            ensure_ascii=False,
        )

    gen = FakeGeneration([obey, obey])
    c = make_client(generator=gen)
    _, j = post(c, body(origin, query="фонтан"))
    user = gen.calls[0]["user"]
    assert "‹/candidates›" in user and user.count("</candidates>") == 1  # data cannot close the block
    assert "evil.example" not in json.dumps(j, ensure_ascii=False)
    assert j["mode"] == "retrieval_only"  # every item rejected twice -> honest fallback
    for card in j["recommendations"]:
        if card["place_id"] == place_ids["inject"]:
            assert "socket" in card["unknown_features"] and card["verified_features"] == []


def test_T15_injection_partial_valid_item_kept(make_client, origin, place_ids):
    def mixed(system, user):
        return json.dumps(
            {
                "recommendations": [
                    {
                        "place_id": alias_for(user, "Инструкция"),
                        "reason": "Есть розетки. http://evil.example",
                        "activity_suggestion": "x",
                    },
                    {
                        "place_id": alias_for(user, "Учебный"),
                        "reason": "Сквер с дорожками.",
                        "activity_suggestion": "Прогуляйтесь.",
                    },
                ],
                "message": "Готово.",
            },
            ensure_ascii=False,
        )

    c = make_client(generator=FakeGeneration([mixed]))
    _, j = post(c, body(origin, query="фонтан и сквер"))
    assert j["mode"] == "live_rag"
    assert [x["place_id"] for x in j["recommendations"]] == [place_ids["park"]]


@pytest.mark.parametrize(
    "exc", [ProviderTimeout("t", retryable=True), ProviderRateLimited("r", retryable=True, status=429)]
)
def test_T16_llm_timeout_or_429_degrades(make_client, origin, exc):
    gen = FakeGeneration([exc])
    c = make_client(generator=gen)
    _, j = post(c, body(origin, query="погулять"))
    assert len(gen.calls) == 1  # no blind retry on provider errors
    assert j["mode"] == "retrieval_only" and j["status"] == "degraded"
    assert "llm_unavailable" in warn_codes(j) and j["recommendations"]


def test_T16_circuit_breaker_skips_llm_after_repeated_failures(make_client, origin):
    gen = FakeGeneration([ProviderTimeout("t"), ProviderTimeout("t"), "{}"])
    c = make_client(generator=gen)
    for _ in range(3):
        _, j = post(c, body(origin, query="погулять"))
        assert j["mode"] == "retrieval_only"
    assert len(gen.calls) == 2


def test_T17_embedding_provider_down(make_client, origin):
    gen = gen_ok(["Учебный"])
    c = make_client(embedder=FakeEmbedding(down=True), generator=gen)
    _, j = post(c, body(origin, query="погулять в сквере"))
    assert j["status"] == "degraded" and j["mode"] == "live_rag"
    assert "embeddings_unavailable" in warn_codes(j)
    assert j["recommendations"]  # lexical + geo still work


@pytest.mark.parametrize("emb", [FakeEmbedding(dim=32), FakeEmbedding(model="other-model")])
def test_T18_dimension_or_model_mismatch(make_client, origin, emb):
    c = make_client(embedder=emb, generator=gen_ok(["Учебный"]))
    _, j = post(c, body(origin, query="погулять в сквере"))
    assert j["status"] == "degraded"
    assert "embeddings_index_mismatch" in warn_codes(j)
    assert not any(kind == "query" for kind, _ in emb.calls)  # mixed vector spaces are never compared
    assert j["recommendations"]


# ---------------------------------------------------------------- hard constraints


def test_T05_hard_socket_requires_verified_yes(make_client, origin, place_ids):
    gen = gen_ok(["Тестовая розетка", "Неизвестная"])
    c = make_client(generator=gen)
    _, j = post(c, body(origin, query="кофе", constraints={"required_features": ["socket"]}))
    assert candidate_names(gen.calls[0]["user"]) == ["SYNTHETIC Кафе «Тестовая розетка»"]
    assert [x["place_id"] for x in j["recommendations"]] == [place_ids["cafe_socket"]]
    vf = j["recommendations"][0]["verified_features"]
    assert {"feature": "socket", "value": True, "basis": "tag", "evidence": "OSM: power_supply=yes"} in vf


def test_T05_S2_no_match_and_relaxation_patch(make_client, origin, place_ids):
    c = make_client(generator=None)
    b = body(
        origin,
        query="Нужны кофе, тишина и розетка, есть час",
        constraints={"exclude_place_ids": [place_ids["cafe_socket"]]},
    )
    _, j = post(c, b)
    assert j["status"] == "no_match" and j["recommendations"] == []
    assert "«розетка»" in j["message"] and "не подтверждено" in j["message"]
    assert "quiet_unverified" in warn_codes(j)
    hard = [h for h in j["constraints_applied"]["hard"] if h["kind"] == "required_feature"]
    assert hard == [
        {"kind": "required_feature", "value": "socket", "source": "text", "label": "Обязательно: розетка"}
    ]
    relax = {r["code"]: r for r in j["suggested_relaxations"]}
    patch = relax["feature_to_preference:socket"]["patch"]
    assert patch["required_features"] == [] and patch["preferred_features"] == ["socket"]
    assert patch["exclude_place_ids"] == [place_ids["cafe_socket"]]
    # resend with the full patch -> results, socket explicitly unknown, never claimed (T06)
    _, j2 = post(c, body(origin, query=b["query"], constraints=patch))
    assert j2["recommendations"]
    for card in j2["recommendations"]:
        assert all(f["feature"] != "socket" for f in card["verified_features"])
        if card["category"] == "cafe":
            assert "socket" in card["unknown_features"]
    assert "preference_unverified:socket" in warn_codes(j2)


def test_T06_preference_socket_unknown_not_claimed(make_client, origin, place_ids):
    def respond(system, user):
        return json.dumps(
            {
                "recommendations": [
                    {
                        "place_id": alias_for(user, "Неизвестная"),
                        "reason": "Есть розетки для ноутбука. Кофе с собой.",
                        "activity_suggestion": "Возьмите кофе.",
                    }
                ],
                "message": "Готово.",
            },
            ensure_ascii=False,
        )

    c = make_client(generator=FakeGeneration([respond]))
    _, j = post(c, body(origin, query="кофе", constraints={"preferred_features": ["socket"]}))
    card = j["recommendations"][0]
    assert card["place_id"] == place_ids["cafe_unknown"]
    assert card["reason"] == "Кофе с собой."
    assert "socket" in card["unknown_features"]


def test_T28_unknown_kids_and_wheelchair(make_client, origin, place_ids):
    def respond(system, user):
        return json.dumps(
            {
                "recommendations": [
                    {
                        "place_id": alias_for(user, "Учебный"),
                        "reason": "Отлично подходит детям. Есть пандусы. Можно погулять.",
                        "activity_suggestion": "Погуляйте по дорожкам.",
                    },
                    {
                        "place_id": alias_for(user, "Детская площадка"),
                        "reason": "Площадка для детей с горкой и качелями.",
                        "activity_suggestion": "Покатайтесь с горки.",
                    },
                ],
                "message": "Готово.",
            },
            ensure_ascii=False,
        )

    c = make_client(generator=FakeGeneration([respond]))
    _, j = post(c, body(origin, query="Хотим погулять час с ребёнком, надо вернуться сюда"))
    cards = {x["place_id"]: x for x in j["recommendations"]}
    park = cards[place_ids["park"]]
    assert park["reason"] == "Можно погулять."
    assert {"kids", "wheelchair"} <= set(park["unknown_features"])
    play = cards[place_ids["playground"]]
    assert play["name_is_generic"] is True and play["name"] == "Детская площадка"
    assert any(f["feature"] == "kids" for f in play["verified_features"])
    assert play["reason"].startswith("Площадка для детей")


def test_exclude_cafe_near_and_indoor(make_client, origin):
    c = make_client(generator=None)
    _, j = post(c, body(origin, query="без кафе", time_budget_min=90))
    assert j["recommendations"] and all(x["category"] != "cafe" for x in j["recommendations"])
    _, near = post(c, body(origin, query="только внутри, поближе", time_budget_min=90))
    hard = {h["kind"]: h for h in near["constraints_applied"]["hard"]}
    assert hard["max_distance"]["value"] == 600 and hard["max_distance"]["source"] == "text"
    assert hard["required_feature"]["value"] == "indoor"
    for card in near["recommendations"]:
        assert card["distance"]["meters"] <= 600
        assert any(f["feature"] == "indoor" for f in card["verified_features"])
    assert "SYNTHETIC ТЦ «Пример»" not in names(near)  # 640 m > 600


def test_needs_clarification_on_conflict(make_client, origin):
    gen = FakeGeneration([])
    c = make_client(generator=gen)
    _, j = post(c, body(origin, query="только кафе", constraints={"exclude_categories": ["cafe"]}))
    assert j["status"] == "needs_clarification" and j["recommendations"] == []
    assert "?" in j["message"] and gen.calls == []


def test_exclude_place_ids(make_client, origin, place_ids):
    c = make_client(generator=None)
    _, j = post(c, body(origin, query="погулять", constraints={"exclude_place_ids": [place_ids["park"]]}))
    assert place_ids["park"] not in [x["place_id"] for x in j["recommendations"]]


# ---------------------------------------------------------------- hours at API level


def test_T09_T10_T11_must_be_open(make_client, origin, place_ids):
    c = make_client(generator=None)
    _, j = post(c, body(origin, query="", time_budget_min=120, constraints={"must_be_open": True}))
    got = [x["place_id"] for x in j["recommendations"]]
    assert place_ids["cafe_evening"] not in got  # closes 12:20, during the visit (T10)
    assert place_ids["museum"] not in got  # PH -> unknown, excluded under must_be_open (T11)
    assert all(x["opening_status"] == "open" for x in j["recommendations"])
    _, j2 = post(
        c, body(origin, query="музей", time_budget_min=120, constraints={"include_categories": ["culture"]})
    )
    museum = [x for x in j2["recommendations"] if x["place_id"] == place_ids["museum"]]
    assert museum and museum[0]["opening_status"] == "unknown" and "PH" in museum[0]["opening_note"]
    assert "unknown_hours" in warn_codes(j2)
    _, j3 = post(c, body(origin, query="", constraints={"include_categories": ["cafe"]}))
    assert place_ids["cafe_evening"] not in [x["place_id"] for x in j3["recommendations"]]


def test_T09_closed_before_arrival_relaxation(make_client, origin):
    c = make_client(generator=None)
    # food place opens 18:00 -> closed at 12:00 arrival; only food requested -> no_match
    _, j = post(c, body(origin, constraints={"include_categories": ["food"]}))
    assert j["status"] == "no_match" and "закрыта" in j["message"]


def test_T12_past_midnight_local(make_client, origin, place_ids):
    c = make_client(generator=None)
    start = FIXED_NOW.replace(hour=23, minute=30)
    _, j = post(c, body(origin, start_time=start.isoformat(), constraints={"include_categories": ["food"]}))
    assert [x["place_id"] for x in j["recommendations"]] == [place_ids["night_food"]]
    assert j["recommendations"][0]["opening_status"] == "open"


def test_start_time_window(make_client, origin):
    c = make_client(generator=None)
    for st in [FIXED_NOW - timedelta(minutes=30), FIXED_NOW + timedelta(days=8)]:
        r = c.post("/api/recommend", json=body(origin, start_time=st.isoformat()))
        assert r.status_code == 422 and r.json()["error"] == "invalid_start_time"
    r = c.post("/api/recommend", json=body(origin, start_time="2026-10-19T12:00:00"))
    assert r.status_code == 422  # naive datetime


# ---------------------------------------------------------------- validation & coverage


def test_T01_query_empty_long_unicode(make_client, origin):
    c = make_client(generator=None)
    assert c.post("/api/recommend", json=body(origin, query="")).status_code == 200
    assert c.post("/api/recommend", json=body(origin, query="х" * 2001)).status_code == 422
    r = c.post("/api/recommend", json=body(origin, query="Сәлем 🌳 парк — қыдыру ‮"))
    assert r.status_code == 200


def test_T02_invalid_coordinates(make_client, origin):
    c = make_client(generator=None)
    raw = json.dumps(body(origin)).replace('"lat": 51.09', '"lat": NaN')
    r = c.post("/api/recommend", content=raw, headers={"content-type": "application/json"})
    assert r.status_code == 422 and r.json()["error"] == "validation_error"
    for o in [{"lat": 95, "lon": 71}, {"lat": 51, "lon": 181}, {"lat": "x", "lon": 71}, {"lat": 51}]:
        r = c.post("/api/recommend", json=body(origin, origin=o))
        assert r.status_code == 422, o
        assert "origin" in r.json()["message"]
    r = c.post("/api/recommend", json=body(origin, origin={"lat": "<script>", "lon": 71}))
    assert "<script>" not in r.text  # submitted values are not echoed


def test_T03_outside_coverage(make_client, origin):
    gen = FakeGeneration([])
    c = make_client(generator=gen)
    _, j = post(c, body(origin, origin={"lat": 51.16, "lon": 71.47}))
    assert j["status"] == "no_match" and "outside_coverage" in warn_codes(j)
    assert "вне района" in j["message"] and gen.calls == []


def test_T04_no_candidates(make_client):
    c = make_client(generator=None)
    _, j = post(c, body({"lat": 51.0785, "lon": 71.3955}, time_budget_min=10))
    assert j["status"] == "no_match" and j["recommendations"] == []
    # 10 min with return: reach radius is ~0 m -> explain the budget instead of "около 0 м" (QA P3)
    assert "Бюджета времени не хватает" in j["message"] and "около 0 м" not in j["message"]


def test_T04_empty_database(make_client, engine, origin):
    seed(engine, empty=True)
    try:
        c = make_client(generator=None)
        _, j = post(c, body(origin))
        assert j["status"] == "no_match" and "data_unavailable" in warn_codes(j)
        assert c.get("/api/ready").json()["components"]["data"]["status"] == "unavailable"
    finally:
        seed(engine)


def test_T26_user_cannot_set_provider_or_source_urls(make_client, origin):
    gen = FakeGeneration([])
    c = make_client(generator=gen)
    for extra in [
        {"ai_base_url": "http://169.254.169.254/"},
        {"source_url": "http://127.0.0.1:5432"},
        {"embedding_base_url": "file:///etc/passwd"},
    ]:
        r = c.post("/api/recommend", json=body(origin, **extra))
        assert r.status_code == 422
    r = c.post("/api/recommend", json=body(origin, constraints={"website": "http://evil"}))
    assert r.status_code == 422
    assert gen.calls == []


def test_T27_negative_and_out_of_range_durations(make_client, origin):
    c = make_client(generator=None)
    for v in [-5, 0, 9, 181]:
        assert c.post("/api/recommend", json=body(origin, time_budget_min=v)).status_code == 422
    assert c.post("/api/recommend", json=body(origin, constraints={"max_distance_m": 50})).status_code == 422
    assert c.post("/api/recommend", json=body(origin, client_request_id="bad id!")).status_code == 422


def test_T07_api_budget_never_exceeded(make_client, origin):
    c = make_client(generator=None)
    for budget in (20, 30, 40, 60):
        for ret in (True, False):
            _, j = post(c, body(origin, time_budget_min=budget, return_to_start=ret))
            for card in j["recommendations"]:
                t = card["timing"]
                assert t["total_min"] <= budget
                assert (t["return_min"] is None) == (not ret)


def test_T25_xss_in_place_name_is_json_data(make_client, origin, place_ids):
    def respond(system, user):
        return json.dumps(
            {
                "recommendations": [
                    {
                        "place_id": alias_for(user, "Галерея"),
                        "reason": "Галерея с выставками <b>искусства</b>.",
                        "activity_suggestion": "Посмотрите выставку.",
                    }
                ],
                "message": "Готово.",
            },
            ensure_ascii=False,
        )

    gen = FakeGeneration([respond])
    c = make_client(generator=gen)
    r, j = post(c, body(origin, query="<img src=x onerror=alert(1)> галерея"))
    assert r.headers["content-type"].startswith("application/json")
    card = j["recommendations"][0]
    assert card["name"] == "SYNTHETIC <script>alert(1)</script> Галерея"  # DB fact, returned verbatim as data
    assert "<script>" not in gen.calls[0]["user"]  # neutralized in the prompt


# ---------------------------------------------------------------- cancellation


def test_cancellable_stops_waiting_on_disconnect():
    async def gone() -> bool:
        return True

    async def run():
        t0 = time.monotonic()
        with pytest.raises(ClientDisconnected):
            await cancellable(lambda: time.sleep(2) or "x", gone, poll_s=0.05)
        return time.monotonic() - t0

    assert asyncio.run(run()) < 1.0


def test_cancellable_returns_result():
    async def here() -> bool:
        return False

    assert asyncio.run(cancellable(lambda: "ok", here, poll_s=0.01)) == "ok"


# ---------------------------------------------------------------- review counter-examples at API level


def test_P1_1_mne_nuzhna_rozetka_is_hard_at_api(make_client, origin, place_ids):
    c = make_client(generator=None)
    _, j = post(c, body(origin, query="Мне нужна розетка, хочу кофе"))
    hard = [h for h in j["constraints_applied"]["hard"] if h["kind"] == "required_feature"]
    assert hard and hard[0]["value"] == "socket" and hard[0]["source"] == "text"
    assert [x["place_id"] for x in j["recommendations"]] == [place_ids["cafe_socket"]]
    _, j2 = post(
        c,
        body(
            origin,
            query="Мне нужна розетка, хочу кофе",
            constraints={"exclude_place_ids": [place_ids["cafe_socket"]]},
        ),
    )
    assert j2["status"] == "no_match"
    assert "feature_to_preference:socket" in {r["code"] for r in j2["suggested_relaxations"]}


def test_P2_1_only_not_cafe_at_api(make_client, origin):
    c = make_client(generator=None)
    _, j = post(c, body(origin, query="Только не кафе", time_budget_min=90))
    assert j["recommendations"] and all(x["category"] != "cafe" for x in j["recommendations"])
    ex = [h for h in j["constraints_applied"]["hard"] if h["kind"] == "exclude_category"]
    assert ex == [{"kind": "exclude_category", "value": "cafe", "source": "text", "label": "Без: Кафе"}]
    assert not [h for h in j["constraints_applied"]["hard"] if h["kind"] == "include_category"]
