"""Deterministic Russian query parser (docs/CONTRACTS.md §5).

Only explicit markers create hard constraints (source="text"):
- features: "нужна/нужен/нужно/обязательно/необходима/только/чтобы была" + feature word in the
  same clause ("розетка", "wi-fi/вайфай"); "внутри/в помещении" (indoor);
- categories: "без кафе/ресторанов/парков/..." (exclude), "только парк/кафе/..." (include);
- "поближе/недалеко/как можно ближе" -> max_distance; "открыто/работает сейчас" -> must_be_open.
Everything else is a soft wish used only for ranking (quiet is never verifiable in OSM).
The LLM never adds hard constraints; UI controls override text.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

NEAR_RADIUS_M = 600

_CLAUSE_SPLIT = re.compile(r"[.!?;\n]+")
_HARD = re.compile(r"обязательн|нужн|необходим|только|должн|чтобы был|непременно|важно")
_SOFT = re.compile(r"желательн|хорошо бы|по возможности|если можно|если есть|было бы|не обязательн|можно без")
_NEG = re.compile(r"не нужн|не обязательн|не надо|не важн|можно без")

_FEATURE_RE: dict[str, re.Pattern[str]] = {
    "socket": re.compile(r"розетк|зарядит|подзаряд|зарядк"),
    "wifi": re.compile(r"wi-?\s?fi|вай-?\s?фай|интернет"),
    "outdoor_seating": re.compile(r"веранд|террас|столик\w* на улице"),
    "wheelchair": re.compile(r"колясочн|инвалидн\w* коляс|пандус|доступн\w* сред"),
}
_INDOOR_RE = re.compile(r"внутри|в помещени|под крыш|в здании")
_KIDS_RE = re.compile(r"реб[её]н|детьми|\bдет(и|ей|ям)\b|детск|с сыном|с дочк|малыш")

_CATEGORY_WORDS: dict[str, str] = {
    "cafe": r"каф[еэ]|кофе\w*|кофейн\w*",
    "food": r"ресторан\w*|ед[аыу]|фастфуд\w*|поесть|столов\w*",
    "park": r"парк\w*|сквер\w*",
    "culture": r"муз[её]\w*|культур\w*|выставк\w*|галере\w*|театр\w*|кино\w*|библиотек\w*",
    "attraction": r"достопримечательн\w*|памятник\w*|монумент\w*|фонтан\w*",
    "playground": r"(?:детск\w*\s+)?площадк\w*",
    "mall": r"торгов\w*(?:\s+центр\w*)?|\bтц\b|молл\w*",
}
_SOFT_CATEGORY_RE: dict[str, re.Pattern[str]] = {
    "cafe": re.compile(r"кофе|кофейн|\bкаф[еэ]\b|капучино|латте|чай"),
    "food": re.compile(r"поесть|\bеда\b|\bеду\b|обед|ужин|завтрак|ресторан|перекус"),
    "park": re.compile(r"погулять|прогул|парк|сквер|свежем воздухе|природ|зелен"),
    "culture": re.compile(r"муз[её]|выставк|галере|театр|\bкино|культур"),
    "attraction": re.compile(r"достопримечат|памятник|монумент|фонтан|архитектур|смотров"),
    "playground": re.compile(r"площадк|реб[её]н|детьми|\bдет(и|ей|ям)\b|малыш"),
    "mall": re.compile(r"торгов|шопинг|магазин|\bтц\b"),
}
_NEAR_RE = re.compile(r"поближе|как можно ближе|недалеко(?!\s+от)|совсем рядом|ближайш|близко(?!\s+от)")
# "Я возле Mega Silk Way" describes the origin, not the wish: such phrases are removed from the
# text used for lexical/semantic retrieval (otherwise the place the user stands at ranks first).
_LOCATION_PHRASE_RE = re.compile(
    r"\b(?:я|мы)?\s*(?:сейчас\s+)?(?:нахожусь|находимся|стою|стоим)?\s*"
    r"(?:возле|около|рядом с(?:о)?|недалеко от|близко от|напротив|у входа в)\s+[^,.;!?\n]{1,60}",
    re.IGNORECASE,
)


def strip_location_phrases(text: str) -> str:
    return re.sub(r"\s+", " ", _LOCATION_PHRASE_RE.sub(" ", text)).strip()


_OPEN_RE = re.compile(r"открыт(о|ы|ое|ые|ый|ая)?\b(?!\s+воздух)|работа\w*\s+сейчас|сейчас\s+работа\w*")
_QUIET_RE = re.compile(r"\bтих\w*|тишин|спокойн|без шума|не шумн|нешумн")
_RETURN_NO_RE = re.compile(r"не (нужно |надо )?возвращ|без возврат|в одну сторону|не возвращ")
_RETURN_YES_RE = re.compile(r"вернуть|обратно|возвращ|назад сюда|вернёмся|вернемся")


@dataclass
class ParsedQuery:
    required_features: list[str] = field(default_factory=list)
    preferred_features: list[str] = field(default_factory=list)
    include_categories: list[str] = field(default_factory=list)
    exclude_categories: list[str] = field(default_factory=list)
    soft_categories: list[str] = field(default_factory=list)
    must_be_open: bool = False
    near: bool = False
    quiet: bool = False
    kids: bool = False
    budget_min: int | None = None
    return_hint: bool | None = None


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower().replace("ё", "е").replace(" ", " ")).strip()


def _add(lst: list[str], item: str) -> None:
    if item not in lst:
        lst.append(item)


def _parse_budget(t: str) -> int | None:
    m = re.search(r"(\d{1,3})\s*(?:-|–)?\s*(?:х\s*)?мин", t)
    if m:
        return int(m.group(1))
    if re.search(r"полтора\s+час", t):
        return 90
    if re.search(r"полчаса|пол часа", t):
        return 30
    m = re.search(r"(\d)\s*(?:-|–)?\s*(?:х\s*)?час", t)
    if m:
        return int(m.group(1)) * 60
    if re.search(r"\bдва\s+часа\b", t):
        return 120
    if re.search(r"\bчас(а|ик|ок)?\b", t):
        return 60
    return None


def parse_query(text: str) -> ParsedQuery:
    out = ParsedQuery()
    t = normalize(text)
    if not t:
        return out
    t_no_air = re.sub(r"открыт\w*\s+воздух\w*", "", t)

    for clause in _CLAUSE_SPLIT.split(t_no_air):
        clause = clause.strip()
        if not clause:
            continue
        hard = bool(_HARD.search(clause)) and not _SOFT.search(clause)
        for feat, rx in _FEATURE_RE.items():
            if rx.search(clause):
                if _NEG.search(clause):
                    continue
                _add(out.required_features if hard else out.preferred_features, feat)
        if _INDOOR_RE.search(clause) and not _NEG.search(clause):
            if _SOFT.search(clause):
                _add(out.preferred_features, "indoor")
            else:
                _add(out.required_features, "indoor")
        if _KIDS_RE.search(clause):
            out.kids = True
            if re.search(r"(обязательн|только)\w*\s+(?:\S+\s+)?детск", clause):
                _add(out.required_features, "kids")
            else:
                _add(out.preferred_features, "kids")

    for cat, words in _CATEGORY_WORDS.items():
        if re.search(rf"\bбез\s+(?:\S+\s+)?(?:{words})", t_no_air):
            _add(out.exclude_categories, cat)
        if re.search(rf"\bтолько\s+(?:в\s+|на\s+|по\s+)?(?:\S+\s+)?(?:{words})", t_no_air):
            _add(out.include_categories, cat)

    for cat, rx in _SOFT_CATEGORY_RE.items():
        if rx.search(t_no_air) and cat not in out.exclude_categories:
            _add(out.soft_categories, cat)

    out.near = bool(_NEAR_RE.search(t_no_air))
    out.must_be_open = bool(_OPEN_RE.search(t_no_air)) and not re.search(r"не важно.{0,20}открыт", t_no_air)
    out.quiet = bool(_QUIET_RE.search(t_no_air))
    out.budget_min = _parse_budget(t_no_air)
    if _RETURN_NO_RE.search(t_no_air):
        out.return_hint = False
    elif _RETURN_YES_RE.search(t_no_air):
        out.return_hint = True

    # A feature cannot be both required and preferred.
    out.preferred_features = [f for f in out.preferred_features if f not in out.required_features]
    return out
