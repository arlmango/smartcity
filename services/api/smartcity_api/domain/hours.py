"""Opening-hours evaluation for the whole visit window (docs/CONTRACTS.md §4).

- Local time zone Asia/Almaty; arrival = start + outbound; window [arrival, arrival + visit].
- open: open over the entire window; closed: a closed interval intersects the window
  (closed at arrival or closes before the end of the visit); unknown otherwise.
- No tag, parse errors, PH/SH (no holiday calendar), sun events (no calibrated coordinates),
  comments ("by appointment") and library "unknown" states are all unknown. unknown != open.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from opening_hours import OpeningHours, State

LOCAL_TZ = ZoneInfo("Asia/Almaty")

_HOLIDAY_RE = re.compile(r"\b(PH|SH)\b")
_SUN_RE = re.compile(r"\b(sunrise|sunset|dawn|dusk)\b", re.IGNORECASE)
_OPEN_END_RE = re.compile(r"\d\+")  # "10:00+" = open end, closing time unknown
_MAX_RAW_LEN = 500


@dataclass(frozen=True)
class OpeningResult:
    status: str  # open | closed | unknown
    note: str


def to_local_naive(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        raise ValueError("timezone-aware datetime required")
    return dt.astimezone(LOCAL_TZ).replace(tzinfo=None)


def evaluate_opening(raw: str | None, arrival: datetime, visit_min: int) -> OpeningResult:
    if raw is None or not raw.strip():
        return OpeningResult("unknown", "Часы работы не указаны в OSM — статус неизвестен")
    raw = raw.strip()
    if len(raw) > _MAX_RAW_LEN:
        return OpeningResult("unknown", "Не удалось разобрать часы работы — статус неизвестен")
    if _HOLIDAY_RE.search(raw):
        return OpeningResult(
            "unknown", "Часы содержат праздничные исключения (PH/SH) — без календаря статус неизвестен"
        )
    if _OPEN_END_RE.search(raw):
        return OpeningResult("unknown", "Время закрытия не указано («+» в часах) — статус неизвестен")
    if _SUN_RE.search(raw):
        return OpeningResult("unknown", "Часы зависят от восхода/заката — статус неизвестен")
    try:
        oh = OpeningHours(raw)
    except Exception:  # library raises its own ParserError / SyntaxError variants
        return OpeningResult("unknown", "Не удалось разобрать часы работы — статус неизвестен")

    start = to_local_naive(arrival)
    end = start + timedelta(minutes=visit_min)
    saw_unknown = False
    try:
        for iv_start, iv_end, state, comment in oh.intervals(start, end):
            if iv_end is not None and iv_end <= start:
                continue
            if iv_start >= end:
                break
            if state == State.CLOSED:
                if iv_start <= start:
                    return OpeningResult("closed", "По данным OSM закрыто ко времени прибытия")
                return OpeningResult("closed", "По данным OSM закрывается до конца посещения")
            if state == State.UNKNOWN or comment:
                saw_unknown = True
    except Exception:
        return OpeningResult("unknown", "Не удалось вычислить часы работы — статус неизвестен")
    if saw_unknown:
        return OpeningResult("unknown", "Часы содержат неопределённые условия — статус неизвестен")
    return OpeningResult(
        "open", "По часам из OSM открыто на всё время посещения (данные снимка могли устареть)"
    )
