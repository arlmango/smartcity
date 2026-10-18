"""Hybrid ranking: BM25 lexical + cosine semantic + distance prior + soft preferences, fused by RRF.

RRF score(d) = Σ_l w_l / (k + rank_l(d)), k = 60, ranks 1-based; a list contributes only for the
candidates it contains (lexical: BM25 > 0; semantic: candidates with an embedding of the active
model; preferences: candidates matching at least one soft wish). Hard constraints are applied
before ranking and re-checked after it; a high score never overrides a failed hard constraint.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

RRF_K = 60
W_LEXICAL = 1.0
W_SEMANTIC = 1.0
W_DISTANCE = 0.5
W_PREFERENCE = 0.75

_TOKEN_RE = re.compile(r"[0-9a-zа-я]+", re.IGNORECASE)
_SUFFIXES = sorted(
    [
        "ами",
        "ями",
        "ого",
        "его",
        "ому",
        "ему",
        "ыми",
        "ими",
        "иях",
        "ах",
        "ях",
        "ых",
        "их",
        "ой",
        "ей",
        "ий",
        "ый",
        "ая",
        "яя",
        "ое",
        "ее",
        "ов",
        "ев",
        "ам",
        "ям",
        "ом",
        "ем",
        "ую",
        "юю",
        "ия",
        "ие",
        "а",
        "я",
        "о",
        "е",
        "ы",
        "и",
        "у",
        "ю",
        "ь",
    ],
    key=len,
    reverse=True,
)
_STOP = {
    "и",
    "в",
    "во",
    "на",
    "с",
    "со",
    "к",
    "по",
    "за",
    "из",
    "у",
    "о",
    "об",
    "от",
    "до",
    "для",
    "не",
    "но",
    "а",
    "я",
    "мы",
    "мне",
    "нам",
    "хочу",
    "хотим",
    "есть",
    "где",
    "что",
    "как",
    "бы",
    "или",
    "это",
    "минут",
    "мин",
    "час",
    "часа",
    "немного",
    "можно",
    "нужно",
    "надо",
    "очень",
    "тут",
    "здесь",
    "сюда",
    "место",
    "места",
    "куда",
    "какое",
    "нибудь",
    "the",
    "a",
    "of",
}


def stem(token: str) -> str:
    t = token.lower().replace("ё", "е")
    for suf in _SUFFIXES:
        if len(t) - len(suf) >= 3 and t.endswith(suf):
            t = t[: -len(suf)]
            break
    return t[:7]


def tokenize(text: str) -> list[str]:
    out = []
    for tok in _TOKEN_RE.findall(text.lower().replace("ё", "е")):
        if tok in _STOP or len(tok) < 2:
            continue
        out.append(stem(tok))
    return out


def bm25_scores(
    query_tokens: Sequence[str], docs: Sequence[Sequence[str]], k1: float = 1.2, b: float = 0.75
) -> list[float]:
    n = len(docs)
    if n == 0 or not query_tokens:
        return [0.0] * n
    avgdl = sum(len(d) for d in docs) / n or 1.0
    df: Counter[str] = Counter()
    for d in docs:
        df.update(set(d))
    q = Counter(query_tokens)
    scores = []
    for d in docs:
        tf = Counter(d)
        dl = len(d) or 1
        s = 0.0
        for term, qtf in q.items():
            if term not in tf:
                continue
            idf = math.log(1 + (n - df[term] + 0.5) / (df[term] + 0.5))
            f = tf[term]
            s += qtf * idf * f * (k1 + 1) / (f + k1 * (1 - b + b * dl / avgdl))
        scores.append(s)
    return scores


@dataclass
class Scored:
    key: str
    rrf: float = 0.0
    ranks: dict[str, int] = field(default_factory=dict)


def rrf_fuse(lists: dict[str, tuple[float, list[str]]], keys: Iterable[str]) -> list[Scored]:
    """lists: name -> (weight, ordered keys). Ties broken by the distance list order then key."""
    table = {k: Scored(k) for k in keys}
    for name, (weight, ordered) in lists.items():
        for rank, key in enumerate(ordered, start=1):
            if key in table:
                table[key].rrf += weight / (RRF_K + rank)
                table[key].ranks[name] = rank
    dist_order = {k: i for i, k in enumerate(lists.get("distance", (0, []))[1])}
    return sorted(table.values(), key=lambda s: (-s.rrf, dist_order.get(s.key, 10**9), s.key))


def diversify(
    ordered: Sequence[str], category_of: dict[str, str], *, n: int, max_per_category: int
) -> list[str]:
    """Pick up to n keys preserving rank order, at most max_per_category per category if possible."""
    picked: list[str] = []
    counts: Counter[str] = Counter()
    for key in ordered:
        if len(picked) >= n:
            break
        if counts[category_of[key]] < max_per_category:
            picked.append(key)
            counts[category_of[key]] += 1
    if len(picked) < n:
        for key in ordered:
            if len(picked) >= n:
                break
            if key not in picked:
                picked.append(key)
    return picked
