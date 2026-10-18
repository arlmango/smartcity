"""Review P2-9: bounded CPU-inference concurrency with honest degradation and slot release."""

from __future__ import annotations

import asyncio
import threading
import time

import pytest
from conftest import body, gen_ok
from fakes import FakeGeneration
from smartcity_api.contracts import RecommendRequest
from smartcity_api.errors import ClientDisconnected
from smartcity_api.providers.base import ProviderTimeout
from smartcity_api.services.recommend import LLM_BUSY_MSG, cancellable, recommend, released_after


def _codes(j) -> set[str]:
    return {w["code"] for w in j["warnings"]}


def _free(sem: threading.BoundedSemaphore) -> bool:
    if sem.acquire(blocking=False):
        sem.release()
        return True
    return False


def test_llm_busy_when_slot_not_obtained(make_client, origin):
    gen = gen_ok(["Учебный"])
    c = make_client(generator=gen, ai_queue_wait_seconds=0.3)
    slots = c.app.state.container.llm_slots
    assert slots.acquire(blocking=False)  # another request holds the only slot
    try:
        t0 = time.monotonic()
        j = c.post("/api/recommend", json=body(origin, query="погулять")).json()
        assert time.monotonic() - t0 < 5
    finally:
        slots.release()
    assert j["mode"] == "retrieval_only" and j["status"] == "degraded"
    assert "llm_busy" in _codes(j) and "llm_unavailable" not in _codes(j)
    assert j["message"].startswith(LLM_BUSY_MSG)
    assert gen.calls == [] and j["recommendations"]


def test_slot_released_after_provider_timeout_and_invalid_output(make_client, origin):
    for script in ([ProviderTimeout("t", retryable=True)], ["{bad", "{bad"]):
        c = make_client(generator=FakeGeneration(list(script)))
        j = c.post("/api/recommend", json=body(origin, query="погулять")).json()
        assert j["mode"] == "retrieval_only"
        assert _free(c.app.state.container.llm_slots)


def test_slot_released_after_success(make_client, origin):
    c = make_client(generator=gen_ok(["Учебный"]))
    assert c.post("/api/recommend", json=body(origin, query="погулять")).json()["mode"] == "live_rag"
    assert _free(c.app.state.container.llm_slots)
    assert _free(c.app.state.container.embed_slots)


def test_slot_released_when_client_disconnects():
    sem = threading.BoundedSemaphore(1)
    assert sem.acquire(blocking=False)

    async def gone() -> bool:
        return True

    async def run():
        with pytest.raises(ClientDisconnected):
            await cancellable(released_after(lambda: time.sleep(0.5) or "x", sem), gone, poll_s=0.05)

    asyncio.run(run())
    # the abandoned provider call still finishes and frees the slot (bounded by its timeout)
    deadline = time.monotonic() + 3
    while not _free(sem) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert _free(sem)


def test_two_concurrent_requests_one_generates_one_busy(make_client, origin):
    good = gen_ok(["Учебный"]).script[0]

    def slow(system, user):
        time.sleep(1.0)
        return good(system, user)

    gen = FakeGeneration([slow, slow])
    c = make_client(generator=gen, ai_queue_wait_seconds=0.2)
    container = c.app.state.container
    req = RecommendRequest(**body(origin, query="погулять"))

    async def both():
        return await asyncio.gather(recommend(container, req), recommend(container, req))

    r1, r2 = asyncio.run(both())
    modes = sorted([r1.mode, r2.mode])
    assert modes == ["live_rag", "retrieval_only"]
    busy = r1 if r1.mode == "retrieval_only" else r2
    assert "llm_busy" in {w.code for w in busy.warnings}
    assert len(gen.calls) == 1
    assert _free(container.llm_slots)


def test_embeddings_busy_degrades(make_client, origin):
    c = make_client(generator=None, embedding_queue_wait_seconds=0.1)
    slots = c.app.state.container.embed_slots
    assert slots.acquire(blocking=False) and slots.acquire(blocking=False)  # both slots taken
    try:
        j = c.post("/api/recommend", json=body(origin, query="погулять")).json()
    finally:
        slots.release()
        slots.release()
    assert "embeddings_busy" in _codes(j) and j["status"] == "degraded" and j["recommendations"]
