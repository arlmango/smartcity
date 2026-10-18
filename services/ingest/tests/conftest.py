"""Test helpers. All OSM data used here is SYNTHETIC (tests/fixtures/osm/*.json)."""

from __future__ import annotations

import copy
import json
import os
from datetime import UTC, datetime
from pathlib import Path

import pytest
from smartcity_api.providers.base import Capabilities, ModelIdentity
from smartcity_ingest.paths import load_coverage
from smartcity_ingest.snapshot import Snapshot, finalize_manifest, write_group
from sqlalchemy import create_engine, text

REPO = Path(__file__).resolve().parents[3]
FIXTURES = REPO / "tests" / "fixtures" / "osm"
TEST_DB = os.environ.get(
    "SMARTCITY_INGEST_TEST_DATABASE_URL",
    "postgresql+psycopg://smartcity:smartcity@localhost:5433/smartcity_test_ingest",
)


def pytest_configure(config):
    config.addinivalue_line("markers", "live: calls real local providers (Ollama bge-m3)")


@pytest.fixture(scope="session")
def engine():
    if not TEST_DB.rstrip("/").endswith("_test_ingest"):
        pytest.exit("refusing to run ingest tests against a non-test database")
    eng = create_engine(TEST_DB, pool_pre_ping=True)
    try:
        with eng.connect() as c:
            c.execute(text("select 1"))
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"test database unavailable: {e}")
    yield eng
    eng.dispose()


@pytest.fixture()
def db(engine):
    with engine.begin() as c:
        c.execute(text("TRUNCATE place_embeddings, place_evidence, places, ingest_runs, coverage CASCADE"))
    return engine


@pytest.fixture(scope="session")
def coverage():
    return load_coverage(REPO / "config" / "coverage.geojson")


@pytest.fixture()
def fixture_groups() -> dict:
    data = json.loads((FIXTURES / "synthetic_small.json").read_text(encoding="utf-8"))
    assert "SYNTHETIC" in data["_comment"]
    return copy.deepcopy(data["groups"])


class SnapshotFactory:
    def __init__(self, base: Path) -> None:
        self.base = base
        self.n = 0

    def __call__(
        self, groups: dict, failed: tuple[str, ...] = (), base_ts: str = "2025-06-01T12:00:00Z"
    ) -> Snapshot:
        self.n += 1
        version = f"osm-20250601T1200{self.n:02d}Z"
        d = self.base / version
        d.mkdir(parents=True)
        manifest = {
            "dataset_version": version,
            "source": "SYNTHETIC fixture",
            "endpoint": "https://example.invalid/overpass",
            "license": "ODbL-1.0",
            "attribution": "© OpenStreetMap contributors",
            "coverage_id": "astana-expo-mega-v1",
            "fetched_at": datetime(2025, 6, 1, 12, 0, self.n, tzinfo=UTC).isoformat(),
            "groups": {},
            "queries": {},
        }
        for name, els in groups.items():
            if name in failed:
                manifest["groups"][name] = {
                    "status": "failed",
                    "error": "HTTP 504 (simulated)",
                    "kind": name.split("_")[0],
                }
                continue
            raw = json.dumps(
                {
                    "version": 0.6,
                    "generator": "SYNTHETIC",
                    "osm3s": {"timestamp_osm_base": base_ts},
                    "elements": els,
                },
                ensure_ascii=False,
            ).encode()
            entry = write_group(d, name, raw)
            entry["kind"] = name.split("_")[0]
            manifest["groups"][name] = entry
        return finalize_manifest(d, manifest)


@pytest.fixture()
def make_snapshot(tmp_path) -> SnapshotFactory:
    return SnapshotFactory(tmp_path / "snapshots")


class FakeEmbedder:
    """Deterministic test-only embedder (never used outside tests)."""

    capabilities = Capabilities(json_mode=False, json_schema=False, max_batch=8)

    def __init__(self, dim: int = 8, model: str = "fake-embed") -> None:
        self.identity = ModelIdentity(provider="fake", model=model, digest="0" * 12)
        self.dim = dim
        self.calls: list[str] = []

    def probe(self) -> ModelIdentity:
        self.identity.dim = self.dim
        return self.identity

    def embed(self, texts: list[str], *, kind: str) -> list[list[float]]:
        import hashlib

        out = []
        for t in texts:
            self.calls.append(t)
            h = hashlib.sha256(t.encode()).digest()
            out.append([b / 255.0 for b in h[: self.dim]])
        return out


@pytest.fixture()
def fake_embedder():
    return FakeEmbedder
