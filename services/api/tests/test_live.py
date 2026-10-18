"""LIVE scenario tests S1–S3: real Ollama (qwen2.5:3b + bge-m3) and the real `smartcity` DB.

Not run by default. Run:
  RUN_LIVE=1 AI_TIMEOUT_SECONDS=240 REQUEST_TIMEOUT_SECONDS=320 \
    uv run pytest services/api/tests/test_live.py -m live -s
Writes de-identified transcripts to artifacts/live/<scenario>.json (origin rounded to 0.01°,
no request IPs). Read-only against the live DB. No fake providers are used here.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from smartcity_api.config import REPO_ROOT, Settings
from smartcity_api.main import create_app
from smartcity_api.runtime import build_container
from sqlalchemy import text

pytestmark = pytest.mark.live

ARTIFACTS = REPO_ROOT / "artifacts" / "live"


class _Capture(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.INFO)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        if getattr(record, "event", None) == "recommend":
            self.records.append(record)


@pytest.fixture(scope="module")
def live():
    settings = Settings()
    dbname = settings.database_url.rsplit("/", 1)[-1]
    container = build_container(settings)
    with container.sessionmaker() as s:
        n = s.execute(text("SELECT count(*) FROM places WHERE active")).scalar() or 0
        cov = s.execute(
            text("SELECT dataset_version FROM coverage ORDER BY updated_at DESC LIMIT 1")
        ).scalar()
    if n == 0 or cov is None:
        pytest.skip(f"live DB {dbname!r} has no active places/coverage yet")
    app = create_app(settings=settings, container=container)
    client = TestClient(app, raise_server_exceptions=False)
    cap = _Capture()
    logging.getLogger("smartcity").addHandler(cap)
    yield {"client": client, "container": container, "settings": settings, "cap": cap, "dataset_version": cov}
    logging.getLogger("smartcity").removeHandler(cap)


def _find_point(container, patterns: list[str]) -> tuple[float, float, str] | None:
    with container.sessionmaker() as s:
        for pat in patterns:
            r = s.execute(
                text(
                    "SELECT name, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon FROM places "
                    "WHERE active AND (name ILIKE :p OR names::text ILIKE :p) ORDER BY name_is_generic, id LIMIT 1"
                ),
                {"p": pat},
            ).first()
            if r:
                return float(r.lat), float(r.lon), r.name
    return None


def _check_facts(container, cards: list[dict]) -> None:
    """Every card's name/coordinates/source come from the DB row with the same place_id."""
    with container.sessionmaker() as s:
        for c in cards:
            r = s.execute(
                text(
                    "SELECT name, source_type, source_id, ST_Y(location::geometry) AS lat, "
                    "ST_X(location::geometry) AS lon FROM places WHERE id = :id AND active"
                ),
                {"id": uuid.UUID(c["place_id"])},
            ).first()
            assert r is not None
            assert c["name"] == r.name
            assert abs(c["coordinates"]["lat"] - r.lat) < 1e-9 and abs(c["coordinates"]["lon"] - r.lon) < 1e-9
            assert c["source"]["url"] == f"https://www.openstreetmap.org/{r.source_type}/{r.source_id}"


def _run(live, scenario: str, payload: dict, notes: str) -> dict:
    client: TestClient = live["client"]
    cap: _Capture = live["cap"]
    before = len(cap.records)
    t0 = time.monotonic()
    r = client.post("/api/recommend", json=payload)
    wall_ms = int((time.monotonic() - t0) * 1000)
    assert r.status_code == 200, r.text
    j = r.json()
    rec_logs = cap.records[before:]
    log = rec_logs[-1] if rec_logs else None
    container = live["container"]
    gen_ident = container.probes.get("llm", container.generator)[0] if container.generator else None
    emb_ident = container.probes.get("embedding", container.embedder)[0] if container.embedder else None
    transcript = {
        "scenario": scenario,
        "notes": notes,
        "recorded_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "deidentified": "origin rounded to 0.01°; scenario text is a fixed test script, not a user's query",
        "request": {
            "query": payload["query"],
            "origin_rounded": [round(payload["origin"]["lat"], 2), round(payload["origin"]["lon"], 2)],
            "time_budget_min": payload["time_budget_min"],
            "return_to_start": payload["return_to_start"],
            "constraints": payload.get("constraints", {}),
        },
        "providers": {
            "llm": {
                "provider": gen_ident.provider if gen_ident else None,
                "model": gen_ident.model if gen_ident else None,
                "digest": gen_ident.digest if gen_ident else None,
                "params": gen_ident.params if gen_ident else None,
                "timeout_s": live["settings"].ai_timeout_seconds,
            },
            "embedding": {
                "model_id": emb_ident.model_id if emb_ident else None,
                "digest": emb_ident.digest if emb_ident else None,
                "dim": emb_ident.dim if emb_ident else None,
            },
            "response_providers": j["providers"],
        },
        "dataset_version": j["dataset_version"],
        "retrieval": {
            "shortlist": getattr(log, "shortlist", None),
            "ranked_after_filters": getattr(log, "ranked", None),
            "semantic": getattr(log, "semantic", None),
            "llm_candidate_ids": getattr(log, "llm_candidate_ids", None),
            "exclusions": getattr(log, "exclusions", None),
            "llm_attempts": getattr(log, "llm_attempts", None),
            "llm_failure": getattr(log, "llm_failure", None),
            "llm_issues": getattr(log, "llm_issues", None),
            "prompt_version": getattr(log, "prompt_version", None),
        },
        "result": {
            "status": j["status"],
            "mode": j["mode"],
            "message": j["message"],
            "constraints_applied": j["constraints_applied"],
            "warnings": j["warnings"],
            "suggested_relaxations": [
                {"code": x["code"], "message": x["message"]} for x in j["suggested_relaxations"]
            ],
            "recommendations": [
                {
                    "place_id": c["place_id"],
                    "name": c["name"],
                    "category": c["category"],
                    "source_url": c["source"]["url"],
                    "distance_m": c["distance"]["meters"],
                    "timing": c["timing"],
                    "opening_status": c["opening_status"],
                    "verified_features": [f["feature"] for f in c["verified_features"]],
                    "unknown_features": c["unknown_features"],
                    "reason": c["reason"],
                    "reason_source": c["reason_source"],
                    "activity_suggestion": c["activity_suggestion"],
                }
                for c in j["recommendations"]
            ],
        },
        "timings_ms": j["timings_ms"],
        "wall_ms": wall_ms,
    }
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    (ARTIFACTS / f"{scenario}.json").write_text(
        json.dumps(transcript, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    _check_facts(container, j["recommendations"])
    return j


def _payload(lat: float, lon: float, query: str, budget: int, ret: bool, **kw) -> dict:
    return {
        "origin": {"lat": lat, "lon": lon},
        "query": query,
        "time_budget_min": budget,
        "return_to_start": ret,
        "client_request_id": f"live-{uuid.uuid4().hex[:12]}",
        **kw,
    }


def test_live_S1_mega_40_min_walk(live):
    pt = _find_point(
        live["container"], ["%MEGA Silk Way%", "%Mega Silk Way%", "%МЕГА Silk Way%", "%Mega%", "%Мега%"]
    )
    if pt is None:
        pytest.skip("MEGA Silk Way not found in the live DB")
    lat, lon, name = pt
    j = _run(
        live,
        "S1",
        _payload(lat, lon, "Я возле Mega Silk Way, есть 40 минут, хочу немного прогуляться", 40, True),
        notes=f"origin = DB location of '{name}'",
    )
    assert j["status"] in ("ok", "degraded")
    assert j["recommendations"]
    assert all(c["timing"]["total_min"] <= 40 for c in j["recommendations"])
    assert j["mode"] == "live_rag", j["warnings"]


def test_live_S2_coffee_quiet_socket(live):
    pt = _find_point(live["container"], ["%Нур Алем%", "%Nur Alem%", "%EXPO%", "%MEGA Silk Way%", "%Mega%"])
    if pt is None:
        pytest.skip("no reference point found")
    lat, lon, name = pt
    q = "Нужны кофе, тишина и розетка, есть час"
    j = _run(live, "S2", _payload(lat, lon, q, 60, True), notes=f"origin = DB location of '{name}'")
    hard = [h for h in j["constraints_applied"]["hard"] if h["kind"] == "required_feature"]
    assert hard and hard[0]["value"] == "socket"
    for c in j["recommendations"]:
        assert any(f["feature"] == "socket" for f in c["verified_features"])  # never unknown under hard
    if not j["recommendations"]:
        assert j["status"] == "no_match"
        relax = [x for x in j["suggested_relaxations"] if x["code"] == "feature_to_preference:socket"]
        if relax:
            j2 = _run(
                live,
                "S2_relaxed",
                _payload(lat, lon, q, 60, True, constraints=relax[0]["patch"]),
                notes="explicit relaxation: socket moved from required to preferred (client resent patch)",
            )
            for c in j2["recommendations"]:
                if not any(f["feature"] == "socket" for f in c["verified_features"]):
                    assert "socket" in c["unknown_features"] or c["category"] != "cafe"


def test_live_S3_hour_with_child_return(live):
    pt = _find_point(live["container"], ["%Нур Алем%", "%Nur Alem%", "%EXPO%", "%MEGA Silk Way%", "%Mega%"])
    if pt is None:
        pytest.skip("no reference point found")
    lat, lon, name = pt
    j = _run(
        live,
        "S3",
        _payload(lat, lon, "Хотим погулять час с ребёнком, надо вернуться сюда", 60, True),
        notes=f"origin = DB location of '{name}'",
    )
    assert j["status"] in ("ok", "degraded", "no_match")
    for c in j["recommendations"]:
        assert c["timing"]["return_min"] is not None and c["timing"]["total_min"] <= 60
