"""Unit tests: budget (T07, T08, T27), opening hours (T09–T12), parser and constraint merging."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from smartcity_api.contracts import Constraints, LatLon, RecommendRequest
from smartcity_api.domain.budget import (
    buffer_minutes,
    compute_timing,
    haversine_m,
    max_reach_radius_m,
    walk_minutes,
)
from smartcity_api.domain.constraints import merge
from smartcity_api.domain.hours import evaluate_opening
from smartcity_api.domain.parser import NEAR_RADIUS_M, parse_query

ALMATY = ZoneInfo("Asia/Almaty")


# ---------------------------------------------------------------- budget


def test_walk_minutes_formula():
    # ceil(d × 1.3 / 66.7): exact multiple must not round up because of float noise
    assert walk_minutes(66.7 * 10 / 1.3) == 10
    assert walk_minutes(0) == 0
    assert walk_minutes(1) == 1
    assert walk_minutes(513.08) == 11  # 513.08*1.3/66.7 = 10.0002 -> 11


def test_buffer_is_max_5_or_ceil_10_percent_integer_exact():
    assert buffer_minutes(10, 10) == 5
    assert buffer_minutes(30, None) == 5  # 10% of 30 = 3 exactly (not 3.0000000000000004 -> 4)
    assert buffer_minutes(30, 30) == 6
    assert buffer_minutes(31, 30) == 7  # ceil(6.1)
    assert buffer_minutes(0, None) == 5


def test_T07_exact_budget_boundary_and_buffer():
    # 12 out + 12 back + buffer 5 = 29; budget 40 leaves 11 >= min 5 (attraction) -> total exactly 40
    t = compute_timing(
        outbound_min=12, return_min=12, time_budget_min=40, default_visit_min=15, min_visit_min=5
    )
    assert t is not None
    assert (t.outbound_min, t.visit_min, t.return_min, t.buffer_min, t.total_min) == (12, 11, 12, 5, 40)
    # visit exactly equal to min_visit is still allowed (boundary inclusive)
    t2 = compute_timing(
        outbound_min=15, return_min=15, time_budget_min=40, default_visit_min=15, min_visit_min=5
    )
    assert t2 is not None and t2.visit_min == 5 and t2.total_min == 40
    # one minute less budget -> visit 4 < min 5 -> excluded
    assert (
        compute_timing(
            outbound_min=15, return_min=15, time_budget_min=39, default_visit_min=15, min_visit_min=5
        )
        is None
    )
    # buffer grows with road time: 30 + 30 -> 6
    t3 = compute_timing(
        outbound_min=30, return_min=30, time_budget_min=100, default_visit_min=30, min_visit_min=10
    )
    assert t3 is not None and t3.buffer_min == 6 and t3.total_min == 96


def test_T08_return_included_and_asymmetric_legs():
    sym = compute_timing(
        outbound_min=10, return_min=10, time_budget_min=60, default_visit_min=45, min_visit_min=20
    )
    asym = compute_timing(
        outbound_min=10, return_min=14, time_budget_min=60, default_visit_min=45, min_visit_min=20
    )
    one_way = compute_timing(
        outbound_min=10, return_min=None, time_budget_min=60, default_visit_min=45, min_visit_min=20
    )
    assert sym and asym and one_way
    assert sym.total_min == 10 + sym.visit_min + 10 + 5
    assert asym.return_min == 14 and asym.visit_min == sym.visit_min - 4  # longer return leg eats visit time
    assert asym.total_min <= 60
    assert one_way.return_min is None and one_way.visit_min == 45
    # without the return the same place fits, with return it does not
    assert compute_timing(
        outbound_min=25, return_min=None, time_budget_min=50, default_visit_min=25, min_visit_min=15
    )
    assert (
        compute_timing(
            outbound_min=25, return_min=25, time_budget_min=50, default_visit_min=25, min_visit_min=15
        )
        is None
    )


def test_T27_negative_duration_and_min_gt_default():
    with pytest.raises(ValueError):
        compute_timing(
            outbound_min=-1, return_min=None, time_budget_min=30, default_visit_min=10, min_visit_min=5
        )
    with pytest.raises(ValueError):
        compute_timing(
            outbound_min=1, return_min=-3, time_budget_min=30, default_visit_min=10, min_visit_min=5
        )
    with pytest.raises(ValueError):
        compute_timing(
            outbound_min=1, return_min=None, time_budget_min=30, default_visit_min=5, min_visit_min=10
        )


def test_haversine_and_reach_radius():
    d = haversine_m(51.09, 71.414, 51.10, 71.414)
    assert 1110 < d < 1113
    r = max_reach_radius_m(
        time_budget_min=40, return_to_start=True, min_visit_min=5, speed_m_per_min=66.7, detour=1.3
    )
    assert r == pytest.approx(15 * 66.7 / 1.3)
    r2 = max_reach_radius_m(
        time_budget_min=40,
        return_to_start=True,
        min_visit_min=5,
        speed_m_per_min=66.7,
        detour=1.3,
        max_distance_m=300,
    )
    assert r2 == 300


# ---------------------------------------------------------------- opening hours


def at(h: int, m: int = 0, day: int = 19) -> datetime:
    return datetime(2026, 10, day, h, m, tzinfo=ALMATY)  # 19 Oct 2026 = Monday


def test_T09_closing_before_arrival():
    r = evaluate_opening("Mo-Su 09:00-12:00", at(12, 5), 20)
    assert r.status == "closed" and "прибытия" in r.note


def test_T10_closing_during_visit():
    r = evaluate_opening("Mo-Su 09:00-12:20", at(12, 0), 25)
    assert r.status == "closed" and "до конца" in r.note
    assert evaluate_opening("Mo-Su 09:00-12:20", at(11, 50), 30).status == "open"  # ends exactly at 12:20


def test_T11_unknown_hours_variants():
    assert evaluate_opening(None, at(12), 20).status == "unknown"
    assert evaluate_opening("", at(12), 20).status == "unknown"
    assert evaluate_opening("по договорённости!!", at(12), 20).status == "unknown"
    assert (
        evaluate_opening("Mo-Fr 09:00-18:00; PH off", at(12), 20).status == "unknown"
    )  # no holiday calendar
    assert evaluate_opening("sunrise-sunset", at(12), 20).status == "unknown"
    assert evaluate_opening('Mo-Su 10:00-20:00 "by appointment"', at(12), 20).status == "unknown"
    assert evaluate_opening("Mo 10:00-14:00 unknown", at(12), 20).status == "unknown"


def test_T12_hours_past_midnight_local_zone():
    oh = "Mo-Su 18:00-02:00"
    assert evaluate_opening(oh, at(23, 30), 40).status == "open"
    assert evaluate_opening(oh, at(1, 0, day=20), 40).status == "open"  # Tue 01:00 belongs to Mon evening
    assert evaluate_opening(oh, at(1, 40, day=20), 40).status == "closed"  # closes 02:00 during visit
    # UTC input is converted to Asia/Almaty: 18:30 UTC = 23:30 local
    utc = datetime(2026, 10, 19, 18, 30, tzinfo=ZoneInfo("UTC"))
    assert evaluate_opening(oh, utc, 30).status == "open"
    assert evaluate_opening("Mo-Su 09:00-17:00", utc, 30).status == "closed"


def test_open_requires_whole_window():
    assert evaluate_opening("24/7", at(3), 120).status == "open"
    assert evaluate_opening("Tu-Su 10:00-18:00", at(12), 30).status == "closed"  # Monday closed


# ---------------------------------------------------------------- parser


def test_parser_S2_hard_socket_and_soft_quiet():
    p = parse_query("Нужны кофе, тишина и розетка, есть час")
    assert p.required_features == ["socket"]
    assert p.quiet is True
    assert "cafe" in p.soft_categories
    assert p.budget_min == 60
    assert p.include_categories == []


def test_parser_preference_vs_hard():
    assert parse_query("Хорошо бы розетка и wi-fi").preferred_features == ["socket", "wifi"]
    assert parse_query("обязательно вайфай").required_features == ["wifi"]
    assert parse_query("розетка не нужна").required_features == []
    assert parse_query("кафе с розеткой").preferred_features == ["socket"]


def test_parser_categories_near_open_indoor():
    p = parse_query("Только парк, без кафе и без ресторанов, поближе")
    assert p.include_categories == ["park"]
    assert set(p.exclude_categories) == {"cafe", "food"}
    assert p.near is True
    assert "cafe" not in p.soft_categories
    assert parse_query("только внутри, в помещении").required_features == ["indoor"]
    assert parse_query("что-нибудь открытое сейчас").must_be_open is True
    assert parse_query("посидеть на открытом воздухе").must_be_open is False
    assert parse_query("тихо и спокойно").quiet is True


def test_parser_kids_return_budget():
    p = parse_query("Хотим погулять час с ребёнком, надо вернуться сюда")
    assert p.kids is True and "kids" in p.preferred_features
    assert "playground" in p.soft_categories and "park" in p.soft_categories
    assert p.return_hint is True and p.budget_min == 60
    assert parse_query("есть 20 минут").budget_min == 20
    assert parse_query("полтора часа").budget_min == 90
    assert parse_query("сейчас").budget_min is None  # "час" inside a word is not a duration


def test_parser_empty_and_unicode():
    assert parse_query("").required_features == []
    p = parse_query("Сәлем! 🌳 Қыдырғым келеді <b>парк</b>")
    assert "park" in p.soft_categories


# ---------------------------------------------------------------- merge


def _req(query: str = "", **c) -> RecommendRequest:
    return RecommendRequest(
        origin=LatLon(lat=51.09, lon=71.414),
        query=query,
        time_budget_min=60,
        constraints=Constraints(**c),
        client_request_id="unit-test-01",
    )


def test_merge_ui_preferred_overrides_text_required():
    req = _req("нужна розетка", preferred_features=["socket"])
    eff = merge(req, parse_query(req.query))
    assert "socket" not in eff.required_features and "socket" in eff.preferred_features


def test_merge_sources_and_near():
    req = _req("поближе, обязательно wi-fi", required_features=["socket"])
    eff = merge(req, parse_query(req.query))
    assert eff.required_features == {"socket": "ui", "wifi": "text"}
    assert eff.max_distance_m == (NEAR_RADIUS_M, "text")
    req2 = _req("поближе", max_distance_m=1500)
    assert merge(req2, parse_query(req2.query)).max_distance_m == (1500, "ui")


def test_merge_conflicts_need_clarification():
    req = _req("только кафе, без кафе")
    assert merge(req, parse_query(req.query)).conflicts
    req2 = _req("только внутри", include_categories=["park"])
    assert merge(req2, parse_query(req2.query)).conflicts
    req3 = _req("", include_categories=["cafe"], exclude_categories=["cafe"])
    assert merge(req3, parse_query("")).conflicts


def test_merge_ui_budget_wins_with_note():
    req = _req("есть 20 минут")
    eff = merge(req, parse_query(req.query))
    assert eff.time_budget_min == 60
    assert any(code == "text_budget_ignored" for code, _ in eff.notes)


def test_location_phrase_is_not_a_wish():
    from smartcity_api.domain.parser import strip_location_phrases

    assert strip_location_phrases("Я возле Mega Silk Way, есть 40 минут, хочу немного прогуляться") == (
        ", есть 40 минут, хочу немного прогуляться"
    )
    assert "Нур" not in strip_location_phrases("мы около Нур Алем. Хотим кофе")
    assert strip_location_phrases("у меня есть час") == "у меня есть час"
    p = parse_query("Я недалеко от EXPO, хочу кофе")
    assert p.near is False and "cafe" in p.soft_categories


def test_diversify_caps_and_rrf():
    from smartcity_api.retrieval.ranking import diversify, rrf_fuse

    groups = {
        "g1": "generic:playground",
        "g2": "generic:playground",
        "p": "park",
        "c": "cafe",
        "g3": "generic:playground",
    }
    order = ["g1", "g2", "g3", "p", "c"]
    assert diversify(order, groups, n=3, max_per_category=3, caps={"generic:playground": 1}) == [
        "g1",
        "p",
        "c",
    ]
    assert diversify(order, groups, n=3, max_per_category=3) == ["g1", "g2", "g3"]
    fused = rrf_fuse({"lexical": (1.0, ["b", "a"]), "distance": (0.5, ["a", "b"])}, ["a", "b"])
    assert [s.key for s in fused] == ["b", "a"]
    assert fused[0].rrf == pytest.approx(1 / 61 + 0.5 / 62)
