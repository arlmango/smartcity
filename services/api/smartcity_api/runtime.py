"""Application runtime container: settings, DB sessions, providers, probe cache, circuit breaker.

Providers are built only from server configuration (never from request data: SSRF guard).
Tests inject their own container with explicitly named fake providers from tests/.
"""

from __future__ import annotations

import concurrent.futures
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy.orm import Session, sessionmaker

from smartcity_api.config import Settings
from smartcity_api.providers.base import EmbeddingProvider, GenerationProvider, ModelIdentity, ProviderError


class CircuitBreaker:
    """Opens after `threshold` consecutive failures; stays open for `cooldown_s` seconds."""

    def __init__(
        self, threshold: int = 2, cooldown_s: float = 60.0, now: Callable[[], float] = time.monotonic
    ):
        self.threshold = threshold
        self.cooldown_s = cooldown_s
        self._now = now
        self._failures = 0
        self._open_until = 0.0
        self._lock = threading.Lock()

    def allow(self) -> bool:
        with self._lock:
            return self._now() >= self._open_until

    def success(self) -> None:
        with self._lock:
            self._failures = 0
            self._open_until = 0.0

    def failure(self) -> None:
        with self._lock:
            self._failures += 1
            if self._failures >= self.threshold:
                self._open_until = self._now() + self.cooldown_s
                self._failures = 0


@dataclass
class _Probe:
    identity: ModelIdentity | None = None
    error: str | None = None
    at: float = 0.0


class ProbeCache:
    """Caches provider probes (identity, digest, actual embedding dim). Failures are cached briefly."""

    def __init__(self, ok_ttl_s: float = 300.0, fail_ttl_s: float = 15.0) -> None:
        self.ok_ttl_s = ok_ttl_s
        self.fail_ttl_s = fail_ttl_s
        self._entries: dict[str, _Probe] = {}
        self._lock = threading.Lock()
        self._inflight: dict[str, concurrent.futures.Future] = {}
        self._pool = concurrent.futures.ThreadPoolExecutor(max_workers=2, thread_name_prefix="probe")

    def get(self, key: str, provider, *, force: bool = False) -> tuple[ModelIdentity | None, str | None]:
        if provider is None:
            return None, "not_configured"
        now = time.monotonic()
        with self._lock:
            entry = self._entries.get(key)
            if entry and not force:
                ttl = self.ok_ttl_s if entry.identity else self.fail_ttl_s
                if now - entry.at < ttl:
                    return entry.identity, entry.error
        try:
            ident = provider.probe()
            result = _Probe(identity=ident, at=now)
        except ProviderError as e:
            result = _Probe(error=f"{e.code}: {e}", at=now)
        except Exception as e:  # defensive: never leak internals, record type only
            result = _Probe(error=f"probe_failed: {type(e).__name__}", at=now)
        with self._lock:
            self._entries[key] = result
        return result.identity, result.error

    def get_bounded(self, key: str, provider, wait_s: float) -> tuple[ModelIdentity | None, str | None]:
        """Like get(), but waits at most wait_s (e.g. a cold model load can take 20-30 s).

        Returns (None, "pending") while the probe is still running in the background; the result
        is cached for later calls. Used by /api/ready so readiness answers quickly.
        """
        if provider is None:
            return None, "not_configured"
        now = time.monotonic()
        with self._lock:
            entry = self._entries.get(key)
            if entry:
                ttl = self.ok_ttl_s if entry.identity else self.fail_ttl_s
                if now - entry.at < ttl:
                    return entry.identity, entry.error
            fut = self._inflight.get(key)
            if fut is None or fut.done():
                fut = self._pool.submit(self.get, key, provider, force=True)
                self._inflight[key] = fut
        try:
            return fut.result(timeout=wait_s)
        except concurrent.futures.TimeoutError:
            return None, "pending"

    def invalidate(self, key: str) -> None:
        with self._lock:
            self._entries.pop(key, None)


def _utcnow() -> datetime:
    return datetime.now(UTC)


@dataclass
class Container:
    settings: Settings
    sessionmaker: sessionmaker[Session]
    embedder: EmbeddingProvider | None
    generator: GenerationProvider | None
    clock: Callable[[], datetime] = _utcnow
    probes: ProbeCache = field(default_factory=ProbeCache)
    llm_breaker: CircuitBreaker = field(default_factory=CircuitBreaker)
    embed_breaker: CircuitBreaker = field(default_factory=CircuitBreaker)
    # Concurrency slots for CPU inference; created from settings when not given.
    llm_slots: threading.BoundedSemaphore | None = None
    embed_slots: threading.BoundedSemaphore | None = None

    def __post_init__(self) -> None:
        if self.llm_slots is None:
            self.llm_slots = threading.BoundedSemaphore(self.settings.ai_max_concurrency)
        if self.embed_slots is None:
            self.embed_slots = threading.BoundedSemaphore(self.settings.embedding_max_concurrency)


def build_container(settings: Settings) -> Container:
    from smartcity_api.db.session import get_sessionmaker
    from smartcity_api.providers.http_providers import build_embedding_provider, build_generation_provider

    return Container(
        settings=settings,
        sessionmaker=get_sessionmaker(settings.database_url),
        embedder=build_embedding_provider(settings),
        generator=build_generation_provider(settings),
    )
