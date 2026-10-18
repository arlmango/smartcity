"""TEST-ONLY fake providers. Never importable from application code or configuration.

FakeEmbedding: deterministic hashed bag-of-stems vectors (not a semantic model).
FakeGeneration: scripted responses for deterministic pipeline tests.
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Callable

from smartcity_api.providers.base import Capabilities, ModelIdentity, ProviderUnavailable
from smartcity_api.retrieval.ranking import tokenize


class FakeEmbedding:
    capabilities = Capabilities(json_mode=False, json_schema=False, max_batch=64)

    def __init__(self, dim: int = 64, model: str = "bag-of-stems", down: bool = False) -> None:
        self.identity = ModelIdentity(provider="fake", model=model, digest="synthetic0000", dim=dim)
        self.dim = dim
        self.down = down
        self.calls: list[tuple[str, list[str]]] = []

    def probe(self) -> ModelIdentity:
        if self.down:
            raise ProviderUnavailable("fake embedding down", retryable=True)
        self.identity.dim = self.dim
        return self.identity

    def embed(self, texts: list[str], *, kind: str) -> list[list[float]]:
        if self.down:
            raise ProviderUnavailable("fake embedding down", retryable=True)
        self.calls.append((kind, list(texts)))
        out = []
        for t in texts:
            v = [0.0] * self.dim
            for tok in tokenize(t):
                h = int(hashlib.sha256(tok.encode()).hexdigest(), 16)
                v[h % self.dim] += 1.0
            n = math.sqrt(sum(x * x for x in v)) or 1.0
            out.append([x / n if n else 0.0 for x in v] if any(v) else [1.0 / math.sqrt(self.dim)] * self.dim)
        return out


Script = str | Exception | Callable[[str, str], str]


class FakeGeneration:
    capabilities = Capabilities(json_mode=True, json_schema=True)

    def __init__(self, script: list[Script] | None = None, probe_error: Exception | None = None) -> None:
        self.identity = ModelIdentity(provider="fake", model="scripted", digest="synthetic0000")
        self.script = list(script or [])
        self.calls: list[dict] = []
        self.probe_error = probe_error

    def probe(self) -> ModelIdentity:
        if self.probe_error:
            raise self.probe_error
        return self.identity

    def generate_json(self, *, system, user, json_schema, max_tokens, temperature, timeout) -> str:
        self.calls.append({"system": system, "user": user, "schema": json_schema, "timeout": timeout})
        if not self.script:
            raise AssertionError("FakeGeneration: no scripted response left")
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        if callable(item):
            return item(system, user)
        return item


def alias_for(user_prompt: str, name_fragment: str) -> str:
    """Find the C<n> alias of a candidate by a fragment of its (neutralized) name in the prompt."""
    import json

    block = user_prompt.split("<candidates>\n", 1)[1].split("\n</candidates>", 1)[0]
    for line in block.splitlines():
        d = json.loads(line)
        if name_fragment in d["name"]:
            return d["place_id"]
    raise KeyError(name_fragment)


def candidate_names(user_prompt: str) -> list[str]:
    import json

    block = user_prompt.split("<candidates>\n", 1)[1].split("\n</candidates>", 1)[0]
    return [json.loads(line)["name"] for line in block.splitlines()]
