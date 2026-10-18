"""Strict validation of model output. The model text is untrusted; invalid output is rejected.

Checks: JSON object shape, known candidate aliases only, no duplicates, length limits, Russian
text, and sentence-level removal of URLs/e-mails/phones/prices/numbers with units (the server owns
all facts and estimates) and of claims about features or opening that are not verified for that
place. An item whose reason becomes empty is dropped; no valid items -> invalid output.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

MAX_REASON = 300
MAX_ACTIVITY = 200
MAX_MESSAGE = 400


class LLMOutputInvalid(Exception):  # noqa: N818 - domain name
    def __init__(self, problem: str) -> None:
        super().__init__(problem)
        self.problem = problem


_URL_RE = re.compile(r"https?://|www\.|\b[\w-]+\.(?:kz|ru|com|org|net|io|info|рф)\b|@", re.IGNORECASE)
_PHONE_RE = re.compile(r"\+?\d[\d\s\-()]{7,}\d")
_UNIT_NUM_RE = re.compile(
    r"\d+(?:[.,]\d+)?\s*(?:тг|тенге|₸|руб|\$|usd|kzt|%|мин|минут|м\b|метр|км|час|ч\b|звезд|балл)",
    re.IGNORECASE,
)
_RATING_RE = re.compile(r"рейтинг|отзыв|из 5\b", re.IGNORECASE)
_CJK_RE = re.compile(r"[぀-ヿ㐀-鿿가-힯]")
_SENT_SPLIT = re.compile(r"(?<=[.!?…])\s+")
# A hedge only neutralizes a feature mention inside the same fragment (between , ; : — / "но" / "а"),
# i.e. it must be about that feature ("розетки не подтверждены"). Advice like "уточните у бариста"
# is not a hedge. Opening, quietness and GROUNDED_TERMS checks ignore hedges entirely.
_HEDGE_RE = re.compile(
    r"не подтвержд|неизвестн|не известн|нет данных|нет информац|не указан|может не быть|не отмечен",
    re.IGNORECASE,
)
_FRAGMENT_SPLIT = re.compile(r"[,;:—–()]|\s-\s|\s(?:но|а|зато|однако)\s", re.IGNORECASE)
_ALWAYS_OPEN_RE = re.compile(r"круглосуточн|24\s*/\s*7|24\s*часа|без выходных", re.IGNORECASE)

FEATURE_CLAIM_RE: dict[str, re.Pattern[str]] = {
    "socket": re.compile(r"розетк|зарядит|подзаряд|зарядк", re.IGNORECASE),
    "wifi": re.compile(r"wi-?\s?fi|вай-?\s?фай|интернет", re.IGNORECASE),
    "outdoor_seating": re.compile(
        r"веранд|террас|летн\w* площадк|столик\w* на улице|мест\w* на улице|(?:по)?сидеть на улице",
        re.IGNORECASE,
    ),
    "wheelchair": re.compile(r"колясочн|инвалид|пандус|маломобил|безбарьер", re.IGNORECASE),
    "indoor": re.compile(r"в помещени|под крыш|в здании|внутри (?:помещ|здан|торгов|тц)", re.IGNORECASE),
    "kids": re.compile(r"\bдет(и|ей|ям|ьми|ск\w*)\b|реб[её]н|малыш", re.IGNORECASE),
}
# Amenity / quality claims that need a basis in the candidate's own factual text.
GROUNDED_TERMS: tuple[str, ...] = (
    "парковк",
    "парковочн",
    "туалет",
    "кондиционер",
    "банкомат",
    "бесплатн",
    "скидк",
    "меню",
    "завтрак",
    "ланч",
    "живая музыка",
    "живой музык",
    "караоке",
    "бассейн",
    "лифт",
    "гардероб",
    "аниматор",
    "батут",
    "безопасн",
    "охраня",
    "доставк",
    "вегетариан",
    "халял",
    "десерт",
    "выпечк",
    "аттракцион",
    "экскурси",
    "билет",
    "вход свободн",
)
_QUIET_CLAIM_RE = re.compile(r"\bтих\w*|тишин|спокойн|уютн|малолюдн|немноголюдн|без шума", re.IGNORECASE)
# Statements that contradict the user's return_to_start control (budget includes / excludes return).
_NO_RETURN_RE = re.compile(
    r"не\s+(?:требу\w*|нужно|надо|обязательно|придётся|придется)\s+(?:\w+\s+)?возвращ|без\s+возвращ|"
    r"в одну сторону|не\s+возвращ",
    re.IGNORECASE,
)
_WITH_RETURN_RE = re.compile(
    r"с возвращением|вернуться (?:в точку|обратно|назад|к началу)|обратн\w* путь", re.IGNORECASE
)
_OPEN_CLAIM_RE = re.compile(r"открыт|работает|работают|до ночи|допоздна|до утра", re.IGNORECASE)


@dataclass
class CandidateFacts:
    alias: str
    place_id: str
    name: str
    verified_features: set[str]
    opening_status: str
    grounding: str = ""  # lower-cased factual text (description, category) the model saw
    opening_hours_raw: str | None = None


@dataclass
class ValidItem:
    place_id: str
    reason: str
    activity_suggestion: str | None


@dataclass
class ValidOutput:
    items: list[ValidItem]
    message: str | None
    issues: list[str] = field(default_factory=list)


def _sanitize(
    text: str,
    facts: CandidateFacts | None,
    issues: list[str],
    *,
    all_verified: set[str],
    names: list[str],
    return_to_start: bool | None = None,
) -> str:
    kept = []
    for sent in _SENT_SPLIT.split(text.strip()):
        raw_s = sent.strip()
        if not raw_s:
            continue
        s = raw_s
        for n in names:  # names are DB facts; do not treat words inside them as claims
            if n:
                s = s.replace(n, " ")
        if _URL_RE.search(s) or _PHONE_RE.search(s):
            issues.append("removed_link_or_phone")
            continue
        if _UNIT_NUM_RE.search(s) or _RATING_RE.search(s):
            issues.append("removed_number_or_rating")
            continue
        verified = facts.verified_features if facts else all_verified
        bad_claim = False
        # 1. Feature claims: every mention must be verified for this place or hedged in its fragment.
        for frag in _FRAGMENT_SPLIT.split(s):
            if bad_claim:
                break
            hedged = bool(_HEDGE_RE.search(frag))
            for feat, rx in FEATURE_CLAIM_RE.items():
                if feat not in verified and rx.search(frag) and not hedged:
                    bad_claim = True
                    issues.append(f"removed_unverified_claim:{feat}")
                    break
        # 2. Opening claims (independent of hedges): "24/7" only for raw "24/7"; "open" only if open.
        raw_hours = (facts.opening_hours_raw or "").strip() if facts else ""
        if not bad_claim and _ALWAYS_OPEN_RE.search(s) and raw_hours != "24/7":
            bad_claim = True
            issues.append("removed_unverified_claim:24_7")
        status_open = facts.opening_status == "open" if facts else False
        if not bad_claim and not status_open and _OPEN_CLAIM_RE.search(s):
            bad_claim = True
            issues.append("removed_unverified_claim:open")
        # 2b. The model must not contradict the return_to_start control.
        if not bad_claim and return_to_start is True and _NO_RETURN_RE.search(s):
            bad_claim = True
            issues.append("removed_contradiction:return_to_start")
        if not bad_claim and return_to_start is False and _WITH_RETURN_RE.search(s):
            bad_claim = True
            issues.append("removed_contradiction:no_return")
        # 3. Quietness: OSM has no such data at all.
        if not bad_claim and _QUIET_CLAIM_RE.search(s):
            bad_claim = True
            issues.append("removed_unverified_claim:quiet")
        # 4. Amenity / quality terms must appear in the candidate's own factual text.
        if not bad_claim:
            low = s.lower().replace("ё", "е")
            grounding = (facts.grounding if facts else "").replace("ё", "е")
            for term in GROUNDED_TERMS:
                if term in low and term not in grounding:
                    bad_claim = True
                    issues.append(f"removed_ungrounded_term:{term}")
                    break
        if bad_claim:
            continue
        kept.append(raw_s)
    return " ".join(kept).strip()


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit]
    end = max(cut.rfind("."), cut.rfind("!"), cut.rfind("?"))
    if end >= limit // 2:
        return cut[: end + 1]
    return cut.rsplit(" ", 1)[0].rstrip(",;:") + "…"


def _mostly_russian(text: str, names: list[str]) -> bool:
    t = text
    for n in names:
        t = t.replace(n, " ")
    if _CJK_RE.search(t):
        return False
    cyr = len(re.findall(r"[а-яё]", t, re.IGNORECASE))
    lat = len(re.findall(r"[a-z]", t, re.IGNORECASE))
    return cyr > 0 and lat <= cyr * 0.3


def validate_output(
    raw: str, candidates: list[CandidateFacts], *, return_to_start: bool | None = None
) -> ValidOutput:
    try:
        data = json.loads(raw)
    except (ValueError, TypeError) as e:
        raise LLMOutputInvalid("ответ не является JSON") from e
    if not isinstance(data, dict):
        raise LLMOutputInvalid("ответ должен быть JSON-объектом")
    recs = data.get("recommendations")
    if not isinstance(recs, list) or not recs:
        raise LLMOutputInvalid("нет списка recommendations")
    by_alias = {c.alias: c for c in candidates}
    names = [c.name for c in candidates]
    all_verified: set[str] = set()
    issues: list[str] = []
    items: list[ValidItem] = []
    seen: set[str] = set()
    unknown_ids = 0
    for rec in recs[:5]:
        if not isinstance(rec, dict):
            issues.append("item_not_object")
            continue
        alias = rec.get("place_id")
        if not isinstance(alias, str) or alias.strip() not in by_alias:
            unknown_ids += 1
            issues.append("unknown_place_id")
            continue
        facts = by_alias[alias.strip()]
        if facts.place_id in seen:
            issues.append("duplicate_place_id")
            continue
        reason = rec.get("reason")
        activity = rec.get("activity_suggestion")
        if not isinstance(reason, str) or not reason.strip():
            issues.append("empty_reason")
            continue
        if activity is not None and not isinstance(activity, str):
            activity = None
        reason_c = _truncate(
            _sanitize(
                reason, facts, issues, all_verified=all_verified, names=names, return_to_start=return_to_start
            ),
            MAX_REASON,
        )
        if not reason_c or not _mostly_russian(reason_c, names):
            issues.append("reason_rejected")
            continue
        activity_c = None
        if activity and activity.strip():
            activity_c = _truncate(
                _sanitize(
                    activity,
                    facts,
                    issues,
                    all_verified=all_verified,
                    names=names,
                    return_to_start=return_to_start,
                ),
                MAX_ACTIVITY,
            )
            if not activity_c or not _mostly_russian(activity_c, names):
                activity_c = None
        seen.add(facts.place_id)
        items.append(ValidItem(facts.place_id, reason_c, activity_c))
        if len(items) == 3:
            break
    if not items:
        if unknown_ids:
            raise LLMOutputInvalid("использованы неизвестные place_id")
        raise LLMOutputInvalid("ни одна рекомендация не прошла проверку")
    message = data.get("message")
    msg_c: str | None = None
    if isinstance(message, str) and message.strip():
        chosen = [by_alias[a] for a in by_alias if by_alias[a].place_id in seen]
        common = set.intersection(*(c.verified_features for c in chosen)) if chosen else set()
        msg_c = (
            _truncate(
                _sanitize(
                    message, None, issues, all_verified=common, names=names, return_to_start=return_to_start
                ),
                MAX_MESSAGE,
            )
            or None
        )
        if msg_c and not _mostly_russian(msg_c, names):
            msg_c = None
    return ValidOutput(items=items, message=msg_c, issues=issues)
