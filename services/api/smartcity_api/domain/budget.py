"""Distance and time budget without a router (docs/CONTRACTS.md §3).

All arithmetic is integer where the contract uses ceil() so that boundary cases are exact
(e.g. 10% of 30 minutes is 3, not 3.0000000000000004 -> 4).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

EARTH_RADIUS_M = 6371008.8
BUFFER_MIN_FLOOR = 5

DISTANCE_NOTE = "По прямой; реальный путь по улицам длиннее"


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def walk_minutes(distance_m: float, *, speed_m_per_min: float = 66.7, detour: float = 1.3) -> int:
    """ceil(d × detour / speed). Rounded to 1e-9 first to avoid float noise at exact multiples."""
    if distance_m <= 0:
        return 0
    return math.ceil(round(distance_m * detour / speed_m_per_min, 9))


def buffer_minutes(outbound_min: int, return_min: int | None) -> int:
    road = outbound_min + (return_min or 0)
    return max(BUFFER_MIN_FLOOR, (road + 9) // 10)  # ceil(0.10 × road) in integers


@dataclass(frozen=True)
class TimingCalc:
    outbound_min: int
    visit_min: int
    return_min: int | None
    buffer_min: int
    total_min: int


def compute_timing(
    *,
    outbound_min: int,
    return_min: int | None,
    time_budget_min: int,
    default_visit_min: int,
    min_visit_min: int,
) -> TimingCalc | None:
    """Full independent budget of one alternative. Legs are separate (asymmetric legs allowed).

    Returns None when the place does not fit (visit would be shorter than the category minimum).
    """
    if outbound_min < 0 or (return_min is not None and return_min < 0):
        raise ValueError("negative leg duration")
    if min_visit_min > default_visit_min:
        raise ValueError("min_visit > default_visit")
    buffer = buffer_minutes(outbound_min, return_min)
    available = time_budget_min - outbound_min - (return_min or 0) - buffer
    visit = min(default_visit_min, available)
    if visit < min_visit_min:
        return None
    total = outbound_min + visit + (return_min or 0) + buffer
    assert total <= time_budget_min
    return TimingCalc(outbound_min, visit, return_min, buffer, total)


def max_reach_radius_m(
    *,
    time_budget_min: int,
    return_to_start: bool,
    min_visit_min: int,
    speed_m_per_min: float,
    detour: float,
    max_distance_m: int | None = None,
) -> float:
    """Upper bound of straight-line distance worth considering (shortlist radius).

    Uses the floor buffer of 5 min, so it never under-estimates the reach; the exact budget
    check happens per candidate in compute_timing.
    """
    legs = 2 if return_to_start else 1
    walk_min = max(0, time_budget_min - min_visit_min - BUFFER_MIN_FLOOR) / legs
    radius = walk_min * speed_m_per_min / detour
    if max_distance_m is not None:
        radius = min(radius, float(max_distance_m))
    return radius


TIMING_METHOD = (
    "Оценка: расстояние по прямой × 1.3, пешком 4 км/ч; запас max(5 мин, 10% дороги); "
    "длительность посещения — типичная для категории"
)
