"""Test fixtures: SYNTHETIC places in the dedicated smartcity_test database + fake providers.

The live database is never touched by default tests: the URL must point to a database whose
name ends with "_test". Live tests (marker `live`) are skipped unless RUN_LIVE=1.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import uuid
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from fakes import FakeEmbedding, FakeGeneration
from fastapi.testclient import TestClient
from smartcity_api.config import REPO_ROOT, Settings
from smartcity_api.main import create_app
from smartcity_api.runtime import CircuitBreaker, Container, ProbeCache
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

TEST_DB_URL = os.environ.get(
    "SMARTCITY_TEST_DATABASE_URL", "postgresql+psycopg://smartcity:smartcity@localhost:5433/smartcity_test"
)
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "api" / "synthetic_places.json"
ALMATY = ZoneInfo("Asia/Almaty")
FIXED_NOW = datetime(2026, 10, 19, 12, 0, tzinfo=ALMATY)  # Monday 12:00 local
EMBED_DIM = 64


def pytest_configure(config):
    config.addinivalue_line("markers", "live: hits real Ollama + the live smartcity DB (RUN_LIVE=1)")


def pytest_collection_modifyitems(config, items):
    if os.environ.get("RUN_LIVE") == "1":
        return
    skip = pytest.mark.skip(reason="live test: set RUN_LIVE=1 to run against real providers/data")
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip)


def offset(origin: dict, north_m: float, east_m: float) -> tuple[float, float]:
    lat = origin["lat"] + north_m / 111195.0
    lon = origin["lon"] + east_m / (111195.0 * math.cos(math.radians(origin["lat"])))
    return lat, lon


def load_fixture() -> dict:
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert data["SYNTHETIC"] is True
    return data


def _guard(url: str) -> None:
    dbname = url.rsplit("/", 1)[-1].split("?", 1)[0]
    if not dbname.endswith("_test"):
        raise RuntimeError(f"refusing to seed non-test database {dbname!r}")


def seed(engine, embedder: FakeEmbedding | None = None, *, empty: bool = False) -> dict[str, str]:
    """Wipe and load the SYNTHETIC fixture. Returns key -> place_id."""
    _guard(str(engine.url.render_as_string(hide_password=True)))
    data = load_fixture()
    origin = data["origin"]
    embedder = embedder or FakeEmbedding(dim=EMBED_DIM)
    ids: dict[str, str] = {}
    collected = datetime(2026, 10, 18, 6, 0, tzinfo=UTC)
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE place_embeddings, place_evidence, places, coverage, ingest_runs CASCADE"))
        if empty:
            return ids
        cov = data["coverage"]
        conn.execute(
            text(
                "INSERT INTO coverage (id, name, geom, dataset_version, freshness, place_count) VALUES "
                "(:id, :name, ST_SetSRID(ST_GeomFromGeoJSON(:gj), 4326), :v, :f, :n)"
            ),
            {
                "id": cov["id"],
                "name": cov["name"],
                "v": cov["dataset_version"],
                "f": collected,
                "n": len(data["places"]),
                "gj": json.dumps({"type": "Polygon", "coordinates": [cov["polygon"]]}),
            },
        )
        for p in data["places"]:
            lat, lon = offset(origin, p["north_m"], p["east_m"])
            content_hash = hashlib.sha256(
                json.dumps(p, sort_keys=True, ensure_ascii=False).encode()
            ).hexdigest()
            pid = conn.execute(
                text(
                    "INSERT INTO places (id, source, source_type, source_id, name, name_is_generic, names, "
                    "geom, location, category, subcategory, tags, description, address, opening_hours_raw, "
                    "website, amenities, active, content_hash, fetched_at) VALUES (:id, 'osm', "
                    ":t, :sid, :name, :generic, '{}'::jsonb, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), "
                    "ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography, :cat, :sub, CAST(:tags AS jsonb), "
                    ":descr, CAST(:addr AS jsonb), :oh, :web, '{}'::jsonb, :active, :hash, :fetched) RETURNING id"
                ),
                {
                    "id": uuid.uuid5(uuid.NAMESPACE_URL, f"synthetic:{p['osm_type']}/{p['osm_id']}"),
                    "t": p["osm_type"],
                    "sid": p["osm_id"],
                    "name": p["name"],
                    "generic": p.get("name_is_generic", False),
                    "lon": lon,
                    "lat": lat,
                    "cat": p["category"],
                    "sub": p["subcategory"],
                    "tags": json.dumps(p.get("tags", {})),
                    "descr": p["description"],
                    "addr": json.dumps(p.get("address", {})),
                    "oh": p.get("opening_hours"),
                    "web": p.get("website"),
                    "active": p.get("active", True),
                    "hash": content_hash,
                    "fetched": collected,
                },
            ).scalar_one()
            ids[p["key"]] = str(pid)
            url = f"https://www.openstreetmap.org/{p['osm_type']}/{p['osm_id']}"
            amenities = {}
            for feat, a in p.get("amenities", {}).items():
                ev_ids = []
                for ev in a.get("ev", []):
                    ev_ids.append(
                        conn.execute(
                            text(
                                "INSERT INTO place_evidence (place_id, field, source_url, collected_at, source_value) "
                                "VALUES (:pid, :f, :u, :c, :v) RETURNING id"
                            ),
                            {"pid": pid, "f": feat, "u": url, "c": collected, "v": ev},
                        ).scalar_one()
                    )
                amenities[feat] = {"value": a["value"], "basis": a["basis"], "evidence_ids": ev_ids}
            conn.execute(
                text("UPDATE places SET amenities = CAST(:a AS jsonb) WHERE id = :pid"),
                {"a": json.dumps(amenities), "pid": pid},
            )
            conn.execute(
                text(
                    "INSERT INTO place_evidence (place_id, field, source_url, collected_at, source_value) "
                    "VALUES (:pid, 'name', :u, :c, :v)"
                ),
                {"pid": pid, "u": url, "c": collected, "v": f"name={p['name']}"},
            )
            vec = embedder.embed([f"{p['name']}. {p['description']}"], kind="document")[0]
            conn.execute(
                text(
                    "INSERT INTO place_embeddings (place_id, embedding, model_id, dim, content_hash, "
                    "embedded_text_hash) VALUES (:pid, CAST(:e AS vector), :m, :d, :h, :h)"
                ),
                {
                    "pid": pid,
                    "e": "[" + ",".join(map(str, vec)) + "]",
                    "m": embedder.identity.model_id,
                    "d": len(vec),
                    "h": content_hash,
                },
            )
    return ids


@pytest.fixture(scope="session")
def engine():
    _guard(TEST_DB_URL)
    eng = create_engine(TEST_DB_URL, pool_pre_ping=True)
    try:
        with eng.connect() as c:
            c.execute(text("SELECT 1"))
    except Exception as e:  # pragma: no cover - environment issue
        pytest.skip(f"test database unavailable: {type(e).__name__}")
    yield eng
    eng.dispose()


@pytest.fixture(scope="session")
def place_ids(engine) -> dict[str, str]:
    return seed(engine)


@pytest.fixture(scope="session")
def data_dir(tmp_path_factory) -> Path:
    d = tmp_path_factory.mktemp("data")
    (d / "map").mkdir()
    for layer in ("buildings", "roads", "water", "green", "coverage"):
        (d / "map" / f"{layer}.geojson").write_text(
            json.dumps({"type": "FeatureCollection", "features": [], "SYNTHETIC": layer}), encoding="utf-8"
        )
    (d / "secret.txt").write_text("must never be served", encoding="utf-8")
    return d


def make_settings(**overrides) -> Settings:
    base = dict(
        database_url=TEST_DB_URL,
        rate_limit="1000/minute",
        rate_limit_general="5000/minute",
        cors_origins="http://localhost:3000",
        ai_timeout_seconds=5.0,
        request_timeout_seconds=60.0,
        log_level="INFO",
    )
    base.update(overrides)
    return Settings(**base)


@pytest.fixture
def make_client(engine, place_ids, data_dir):
    def _make(
        *,
        embedder=None,
        generator=None,
        clock=lambda: FIXED_NOW,
        use_default_embedder: bool = True,
        **overrides,
    ) -> TestClient:
        overrides.setdefault("data_dir", data_dir)
        settings = make_settings(**overrides)
        if embedder is None and use_default_embedder:
            embedder = FakeEmbedding(dim=EMBED_DIM)
        container = Container(
            settings=settings,
            sessionmaker=sessionmaker(bind=engine, expire_on_commit=False),
            embedder=embedder,
            generator=generator,
            clock=clock,
            probes=ProbeCache(),
            llm_breaker=CircuitBreaker(),
            embed_breaker=CircuitBreaker(),
        )
        app = create_app(settings=settings, container=container)
        return TestClient(app, raise_server_exceptions=False)

    return _make


@pytest.fixture
def origin() -> dict:
    return dict(load_fixture()["origin"])


def body(default_origin: dict, **kw) -> dict:
    b = {
        "origin": default_origin,
        "query": "",
        "time_budget_min": 60,
        "return_to_start": True,
        "client_request_id": "test-req-0001",
        "start_time": FIXED_NOW.isoformat(),
    }
    b.update(kw)
    return b


def gen_ok(pick: list[str], reason: str = "Подходит для короткой прогулки рядом.", **extra) -> FakeGeneration:
    """FakeGeneration that picks candidates by name fragments in the prompt."""
    from fakes import alias_for

    def respond(system: str, user: str) -> str:
        recs = []
        for frag in pick:
            try:
                recs.append(
                    {
                        "place_id": alias_for(user, frag),
                        "reason": reason,
                        "activity_suggestion": "Пройдитесь и осмотритесь.",
                    }
                )
            except KeyError:
                continue
        return json.dumps(
            {"recommendations": recs, "message": "Вот что нашлось рядом.", **extra}, ensure_ascii=False
        )

    return FakeGeneration([respond])
