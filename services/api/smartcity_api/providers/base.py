"""Provider interfaces for embeddings and generation.

Real adapters: Ollama (local, free software) and OpenAI-compatible HTTP servers configured by
the operator via environment (base URL + server-side secret). Base URLs come only from
configuration, never from user requests (SSRF guard).

Fake providers exist only under tests/ and are never selectable through configuration.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


class ProviderError(Exception):
    """Base error. `retryable` marks transient failures (timeouts, 429, 5xx)."""

    code = "provider_error"

    def __init__(self, message: str, *, retryable: bool = False, status: int | None = None) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status = status


class ProviderUnavailable(ProviderError):
    code = "provider_unavailable"


class ProviderTimeout(ProviderError):
    code = "provider_timeout"


class ProviderRateLimited(ProviderError):
    code = "provider_rate_limited"


class ProviderBadResponse(ProviderError):
    code = "provider_bad_response"


@dataclass(frozen=True)
class Capabilities:
    """What the adapter actually supports (verified by contract tests, not assumed)."""

    json_mode: bool
    json_schema: bool
    max_batch: int = 32


@dataclass
class ModelIdentity:
    provider: str
    model: str
    digest: str | None = None
    dim: int | None = None
    params: dict = field(default_factory=dict)

    @property
    def model_id(self) -> str:
        suffix = f"@{self.digest[:12]}" if self.digest else ""
        return f"{self.provider}:{self.model}{suffix}"


class EmbeddingProvider(Protocol):
    identity: ModelIdentity
    capabilities: Capabilities

    def probe(self) -> ModelIdentity:
        """Call the real endpoint, determine digest (if available) and the actual dimension."""
        ...

    def embed(self, texts: list[str], *, kind: str) -> list[list[float]]:
        """kind is "query" or "document"; adapters apply the model's documented preprocessing."""
        ...


class GenerationProvider(Protocol):
    identity: ModelIdentity
    capabilities: Capabilities

    def probe(self) -> ModelIdentity: ...

    def generate_json(
        self,
        *,
        system: str,
        user: str,
        json_schema: dict | None,
        max_tokens: int,
        temperature: float,
        timeout: float,
    ) -> str:
        """Return raw model text (expected to be JSON). Callers validate; adapters never trust it."""
        ...
