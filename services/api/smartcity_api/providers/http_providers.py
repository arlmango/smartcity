"""Real HTTP adapters: Ollama and OpenAI-compatible servers."""

from __future__ import annotations

import httpx

from smartcity_api.config import Settings
from smartcity_api.providers.base import (
    Capabilities,
    ModelIdentity,
    ProviderBadResponse,
    ProviderError,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
)

# Query/document preprocessing per embedding model family. bge-m3 dense retrieval uses no
# instruction prefix; e5-family models require "query: "/"passage: ".
_PREFIXES: dict[str, tuple[str, str]] = {
    "e5": ("query: ", "passage: "),
}


def _prefixes(model: str) -> tuple[str, str]:
    low = model.lower()
    for key, value in _PREFIXES.items():
        if key in low and "bge" not in low:
            return value
    return ("", "")


def _raise_for(resp: httpx.Response, what: str) -> None:
    if resp.status_code == 429:
        raise ProviderRateLimited(f"{what}: rate limited", retryable=True, status=429)
    if resp.status_code >= 500:
        raise ProviderUnavailable(f"{what}: upstream {resp.status_code}", retryable=True, status=resp.status_code)
    if resp.status_code >= 400:
        raise ProviderError(f"{what}: HTTP {resp.status_code}", status=resp.status_code)


def _request(client: httpx.Client, method: str, url: str, what: str, **kw) -> dict:
    try:
        resp = client.request(method, url, **kw)
    except httpx.TimeoutException as e:
        raise ProviderTimeout(f"{what}: timeout", retryable=True) from e
    except httpx.HTTPError as e:
        raise ProviderUnavailable(f"{what}: {type(e).__name__}", retryable=True) from e
    _raise_for(resp, what)
    try:
        return resp.json()
    except ValueError as e:
        raise ProviderBadResponse(f"{what}: non-JSON response") from e


class OllamaEmbedding:
    capabilities = Capabilities(json_mode=False, json_schema=False, max_batch=32)

    def __init__(self, base_url: str, model: str, timeout: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.identity = ModelIdentity(provider="ollama", model=model)
        self._client = httpx.Client(timeout=timeout)
        self._qp, self._dp = _prefixes(model)

    def probe(self) -> ModelIdentity:
        tags = _request(self._client, "GET", f"{self.base_url}/api/tags", "ollama tags")
        for m in tags.get("models", []):
            if m.get("name") in (self.identity.model, f"{self.identity.model}:latest"):
                self.identity.digest = m.get("digest")
                break
        else:
            raise ProviderUnavailable(f"ollama: model {self.identity.model} is not pulled")
        vec = self.embed(["probe"], kind="query")[0]
        self.identity.dim = len(vec)
        return self.identity

    def embed(self, texts: list[str], *, kind: str) -> list[list[float]]:
        prefix = self._qp if kind == "query" else self._dp
        out: list[list[float]] = []
        for i in range(0, len(texts), self.capabilities.max_batch):
            batch = [prefix + t for t in texts[i : i + self.capabilities.max_batch]]
            data = _request(
                self._client,
                "POST",
                f"{self.base_url}/api/embed",
                "ollama embed",
                json={"model": self.identity.model, "input": batch, "truncate": True},
            )
            vecs = data.get("embeddings")
            if not isinstance(vecs, list) or len(vecs) != len(batch):
                raise ProviderBadResponse("ollama embed: unexpected payload")
            out.extend(vecs)
        return out


class OllamaGeneration:
    capabilities = Capabilities(json_mode=True, json_schema=True)

    def __init__(self, base_url: str, model: str, timeout: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.identity = ModelIdentity(provider="ollama", model=model)
        self._client = httpx.Client(timeout=timeout)

    def probe(self) -> ModelIdentity:
        tags = _request(self._client, "GET", f"{self.base_url}/api/tags", "ollama tags")
        for m in tags.get("models", []):
            if m.get("name") in (self.identity.model, f"{self.identity.model}:latest"):
                self.identity.digest = m.get("digest")
                return self.identity
        raise ProviderUnavailable(f"ollama: model {self.identity.model} is not pulled")

    def generate_json(self, *, system, user, json_schema, max_tokens, temperature, timeout) -> str:
        self.identity.params = {"temperature": temperature, "num_predict": max_tokens}
        data = _request(
            self._client,
            "POST",
            f"{self.base_url}/api/chat",
            "ollama chat",
            json={
                "model": self.identity.model,
                "stream": False,
                "format": json_schema if json_schema else "json",
                "options": {"temperature": temperature, "num_predict": max_tokens, "num_ctx": 8192},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            },
            timeout=timeout,
        )
        content = (data.get("message") or {}).get("content")
        if not isinstance(content, str):
            raise ProviderBadResponse("ollama chat: missing content")
        return content


class OpenAICompatEmbedding:
    capabilities = Capabilities(json_mode=False, json_schema=False, max_batch=64)

    def __init__(self, base_url: str, model: str, api_key: str, timeout: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.identity = ModelIdentity(provider="openai_compatible", model=model)
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._client = httpx.Client(timeout=timeout, headers=headers)
        self._qp, self._dp = _prefixes(model)

    def probe(self) -> ModelIdentity:
        self.identity.dim = len(self.embed(["probe"], kind="query")[0])
        return self.identity

    def embed(self, texts: list[str], *, kind: str) -> list[list[float]]:
        prefix = self._qp if kind == "query" else self._dp
        out: list[list[float]] = []
        for i in range(0, len(texts), self.capabilities.max_batch):
            batch = [prefix + t for t in texts[i : i + self.capabilities.max_batch]]
            data = _request(
                self._client,
                "POST",
                f"{self.base_url}/embeddings",
                "embeddings",
                json={"model": self.identity.model, "input": batch},
            )
            items = sorted(data.get("data", []), key=lambda d: d.get("index", 0))
            if len(items) != len(batch):
                raise ProviderBadResponse("embeddings: unexpected payload")
            out.extend(item["embedding"] for item in items)
        return out


class OpenAICompatGeneration:
    # json_schema support differs between servers; json_object is the portable baseline.
    capabilities = Capabilities(json_mode=True, json_schema=False)

    def __init__(self, base_url: str, model: str, api_key: str, timeout: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.identity = ModelIdentity(provider="openai_compatible", model=model)
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._client = httpx.Client(timeout=timeout, headers=headers)

    def probe(self) -> ModelIdentity:
        data = _request(self._client, "GET", f"{self.base_url}/models", "models")
        ids = {m.get("id") for m in data.get("data", [])}
        if self.identity.model not in ids:
            raise ProviderUnavailable(f"model {self.identity.model} not offered by endpoint")
        return self.identity

    def generate_json(self, *, system, user, json_schema, max_tokens, temperature, timeout) -> str:
        self.identity.params = {"temperature": temperature, "max_tokens": max_tokens}
        data = _request(
            self._client,
            "POST",
            f"{self.base_url}/chat/completions",
            "chat",
            json={
                "model": self.identity.model,
                "temperature": temperature,
                "max_tokens": max_tokens,
                "response_format": {"type": "json_object"},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            },
            timeout=timeout,
        )
        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as e:
            raise ProviderBadResponse("chat: missing content") from e


def build_embedding_provider(s: Settings):
    if s.embedding_provider == "ollama":
        return OllamaEmbedding(s.embedding_base_url, s.embedding_model, s.embedding_timeout_seconds)
    if s.embedding_provider == "openai_compatible":
        return OpenAICompatEmbedding(
            s.embedding_base_url, s.embedding_model, s.embedding_api_key.get_secret_value(),
            s.embedding_timeout_seconds,
        )
    return None


def build_generation_provider(s: Settings):
    if s.ai_provider == "ollama":
        return OllamaGeneration(s.ai_base_url, s.ai_model, s.ai_timeout_seconds)
    if s.ai_provider == "openai_compatible":
        return OpenAICompatGeneration(
            s.ai_base_url, s.ai_model, s.ai_api_key.get_secret_value(), s.ai_timeout_seconds
        )
    return None
