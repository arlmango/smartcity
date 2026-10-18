"""Incremental embeddings index (place_embeddings).

Rows are keyed by (place_id, model_id). A place is re-embedded only when its content_hash or
the embedded text hash differs from the stored row for the *active* model. Vectors of other
models are never mixed in: they live under their own model_id and can be pruned explicitly.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from smartcity_api.db.models import Place, PlaceEmbedding
from smartcity_api.providers.base import ProviderError
from sqlalchemy import Engine, delete, func, select
from sqlalchemy.orm import Session

from smartcity_ingest.normalize import CATEGORY_LABELS, SUBCATEGORY_LABELS, cuisine_text

log = logging.getLogger("smartcity_ingest.indexer")


def embedding_text(p: Place) -> str:
    """Text embedded for a place: only factual fields stored in the DB."""
    parts = [p.name, CATEGORY_LABELS.get(p.category, p.category)]
    sub = SUBCATEGORY_LABELS.get(p.subcategory, p.subcategory)
    if sub and sub.lower() != parts[1].lower():
        parts.append(sub)
    tags = p.tags or {}
    if (cu := cuisine_text(tags)) is not None:
        parts.append(f"кухня: {cu}")
    addr = (p.address or {}).get("formatted")
    if addr:
        parts.append(f"адрес: {addr}")
    if p.description:
        parts.append(p.description)
    return "\n".join(parts)


def text_hash(t: str) -> str:
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


@dataclass
class IndexResult:
    model_id: str
    dim: int
    embedded: int
    skipped: int
    pruned_other_models: int
    total_rows_for_model: int
    other_model_rows: int


def _embed_with_retry(provider, texts: list[str], attempts: int, sleep) -> list[list[float]]:
    for attempt in range(1, attempts + 1):
        try:
            return provider.embed(texts, kind="document")
        except ProviderError as e:
            if not e.retryable or attempt == attempts:
                raise
            log.warning("embed attempt %d/%d failed (%s); retrying", attempt, attempts, e)
            sleep(5.0 * attempt)
    raise AssertionError("unreachable")


def run_index(
    engine: Engine,
    provider,
    *,
    prune_other_models: bool = False,
    batch: int = 8,
    attempts: int = 3,
    sleep=time.sleep,
) -> IndexResult:
    """Embeds changed/new active places. Each batch is committed on its own, so an interrupted run
    keeps its progress and the next run continues incrementally (never mixing models)."""
    ident = provider.probe()
    if not ident.dim:
        raise RuntimeError("embedding provider probe returned no dimension")
    model_id = ident.model_id
    with Session(engine, expire_on_commit=False) as s:
        places = list(s.scalars(select(Place).where(Place.active.is_(True)).order_by(Place.id)))
        rows = {
            r.place_id: r
            for r in s.scalars(select(PlaceEmbedding).where(PlaceEmbedding.model_id == model_id))
        }
        todo: list[tuple[Place, str, str]] = []
        skipped = 0
        for p in places:
            t = embedding_text(p)
            th = text_hash(t)
            r = rows.get(p.id)
            if (
                r is not None
                and r.content_hash == p.content_hash
                and r.embedded_text_hash == th
                and r.dim == ident.dim
            ):
                skipped += 1
                continue
            todo.append((p, t, th))
        done = 0
        for i in range(0, len(todo), batch):
            chunk = todo[i : i + batch]
            vecs = _embed_with_retry(provider, [t for _, t, _ in chunk], attempts, sleep)
            if len(vecs) != len(chunk):
                raise RuntimeError("embedding provider returned wrong number of vectors")
            for (p, _, th), v in zip(chunk, vecs, strict=True):
                if len(v) != ident.dim:
                    raise RuntimeError(f"vector dim {len(v)} != probed dim {ident.dim}")
                r = rows.get(p.id)
                if r is None:
                    r = PlaceEmbedding(
                        place_id=p.id,
                        embedding=v,
                        model_id=model_id,
                        dim=ident.dim,
                        content_hash=p.content_hash,
                        embedded_text_hash=th,
                    )
                    s.add(r)
                    rows[p.id] = r
                else:
                    r.embedding = v
                    r.dim = ident.dim
                    r.content_hash = p.content_hash
                    r.embedded_text_hash = th
                    r.created_at = datetime.now(UTC)
                    rows[p.id] = r
            s.commit()
            done += len(chunk)
            log.info("embedded %d/%d", done, len(todo))
        pruned = 0
        if prune_other_models:
            pruned = (
                s.execute(delete(PlaceEmbedding).where(PlaceEmbedding.model_id != model_id)).rowcount or 0
            )
            s.commit()
        total = s.scalar(
            select(func.count()).select_from(PlaceEmbedding).where(PlaceEmbedding.model_id == model_id)
        )
        other = s.scalar(
            select(func.count()).select_from(PlaceEmbedding).where(PlaceEmbedding.model_id != model_id)
        )
    return IndexResult(
        model_id=model_id,
        dim=ident.dim,
        embedded=done,
        skipped=skipped,
        pruned_other_models=pruned,
        total_rows_for_model=total or 0,
        other_model_rows=other or 0,
    )


def write_index_manifest(path: Path, res: IndexResult, provider, active_places: int) -> dict:
    ident = provider.identity
    m = {
        "model_id": res.model_id,
        "provider": ident.provider,
        "model": ident.model,
        "digest": ident.digest,
        "dim": res.dim,
        "document_preprocessing": "no prefix (bge-m3 dense)"
        if "bge" in ident.model.lower()
        else "adapter default",
        "text_fields": ["name", "category label (ru)", "subcategory", "cuisine", "address", "description"],
        "active_places": active_places,
        "rows_for_model": res.total_rows_for_model,
        "rows_other_models": res.other_model_rows,
        "last_run": {
            "at": datetime.now(UTC).isoformat(),
            "embedded": res.embedded,
            "skipped_unchanged": res.skipped,
            "pruned_other_models": res.pruned_other_models,
        },
        "vector_index": "exact scan (no ANN index); dataset ~10^2 rows",
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(m, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return m
