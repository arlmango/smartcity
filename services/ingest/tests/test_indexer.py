"""Incremental indexing tests. FakeEmbedder is defined only in tests/conftest.py."""

from __future__ import annotations

import math

import httpx
import pytest
from smartcity_api.db.models import Place, PlaceEmbedding
from smartcity_ingest.importer import run_import
from smartcity_ingest.indexer import embedding_text, run_index
from sqlalchemy import select, text
from sqlalchemy.orm import Session


def test_incremental_index_reembeds_only_changed(db, coverage, fixture_groups, make_snapshot, fake_embedder):
    run_import(db, make_snapshot(fixture_groups), coverage)
    emb = fake_embedder()
    r1 = run_index(db, emb)
    assert r1.embedded == 11 and r1.skipped == 0 and r1.dim == 8
    assert r1.model_id == "fake:fake-embed@000000000000"
    r2 = run_index(db, emb)
    assert r2.embedded == 0 and r2.skipped == 11
    fixture_groups["poi_culture"][0]["tags"]["opening_hours"] = "Tu-Su 10:00-18:00"
    run_import(db, make_snapshot(fixture_groups), coverage)
    emb.calls.clear()
    r3 = run_index(db, emb)
    assert r3.embedded == 1 and r3.skipped == 10
    assert len(emb.calls) == 1 and "SYNTH Музей" in emb.calls[0] and "Tu-Su 10:00-18:00" in emb.calls[0]
    with Session(db) as s:
        p = s.scalars(select(Place).where(Place.source_id == 1101)).one()
        row = s.scalars(select(PlaceEmbedding).where(PlaceEmbedding.place_id == p.id)).one()
        assert row.content_hash == p.content_hash


def test_models_not_mixed_and_prune(db, coverage, fixture_groups, make_snapshot, fake_embedder):
    run_import(db, make_snapshot(fixture_groups), coverage)
    run_index(db, fake_embedder(dim=8, model="model-a"))
    rb = run_index(db, fake_embedder(dim=4, model="model-b"))
    assert rb.embedded == 11 and rb.other_model_rows == 11
    with Session(db) as s:
        dims = dict(
            s.execute(text("select model_id, max(dim) from place_embeddings group by model_id")).all()
        )
    assert dims == {"fake:model-a@000000000000": 8, "fake:model-b@000000000000": 4}
    rp = run_index(db, fake_embedder(dim=4, model="model-b"), prune_other_models=True)
    assert rp.embedded == 0 and rp.pruned_other_models == 11 and rp.other_model_rows == 0


def test_interrupted_index_keeps_committed_batches(
    db, coverage, fixture_groups, make_snapshot, fake_embedder
):
    from smartcity_api.providers.base import ProviderTimeout

    run_import(db, make_snapshot(fixture_groups), coverage)
    emb = fake_embedder()
    orig = emb.embed
    state = {"n": 0}

    def flaky(texts, *, kind):
        state["n"] += 1
        if state["n"] == 2:  # first try of batch 2: transient timeout -> retried
            raise ProviderTimeout("timeout", retryable=True)
        if state["n"] >= 4:  # batch 3: persistent failure
            raise ProviderTimeout("timeout", retryable=False)
        return orig(texts, kind=kind)

    emb.embed = flaky
    with pytest.raises(ProviderTimeout):
        run_index(db, emb, batch=4, sleep=lambda s: None)
    with Session(db) as s:
        assert s.scalar(text("select count(*) from place_embeddings")) == 8  # 2 batches committed
    emb.embed = orig
    r = run_index(db, emb, batch=4)
    assert r.embedded == 3 and r.skipped == 8


def test_inactive_places_not_indexed(db, coverage, fixture_groups, make_snapshot, fake_embedder):
    g2 = dict(fixture_groups)
    run_import(db, make_snapshot(fixture_groups), coverage)
    g2["poi_culture"] = []
    run_import(db, make_snapshot(g2), coverage)
    r = run_index(db, fake_embedder())
    assert r.embedded == 10


def test_embedding_text_uses_factual_fields(db, coverage, fixture_groups, make_snapshot):
    run_import(db, make_snapshot(fixture_groups), coverage)
    with Session(db) as s:
        p = s.scalars(select(Place).where(Place.source_type == "way", Place.source_id == 9001)).one()
        t = embedding_text(p)
    assert t.startswith("SYNTH Кафе «Дубль»\nКафе")
    assert "кухня: кофейня" in t


def _ollama_up() -> bool:
    try:
        r = httpx.get("http://localhost:11434/api/tags", timeout=3)
        return any(m.get("name", "").startswith("bge-m3") for m in r.json().get("models", []))
    except Exception:  # noqa: BLE001
        return False


def _cos(a, b):
    return sum(x * y for x, y in zip(a, b, strict=True)) / (
        math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    )


@pytest.mark.live
@pytest.mark.skipif(not _ollama_up(), reason="Ollama with bge-m3 not reachable on localhost:11434")
def test_live_bge_m3_index(db, coverage, fixture_groups, make_snapshot):
    from smartcity_api.providers.http_providers import OllamaEmbedding

    run_import(db, make_snapshot(fixture_groups), coverage)
    prov = OllamaEmbedding("http://localhost:11434", "bge-m3", 300.0)
    r = run_index(db, prov)
    assert r.dim == 1024 and r.embedded == 11
    assert r.model_id.startswith("ollama:bge-m3@")
    r2 = run_index(db, prov)
    assert r2.embedded == 0
    q = prov.embed(["музей, экспозиция, выставка"], kind="query")[0]
    with Session(db) as s:
        rows = s.execute(
            select(Place.name, PlaceEmbedding.embedding).join(
                PlaceEmbedding, PlaceEmbedding.place_id == Place.id
            )
        ).all()
    sims = {name: _cos(q, list(vec)) for name, vec in rows}
    best = max(sims, key=sims.get)
    assert best == "SYNTH Музей", sims
