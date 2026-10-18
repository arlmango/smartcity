"""Normalized categories (docs/CONTRACTS.md §1) and feature labels (§2)."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CategoryInfo:
    label: str
    default_visit_min: int  # estimate, not a fact
    min_visit_min: int


CATEGORY_INFO: dict[str, CategoryInfo] = {
    "cafe": CategoryInfo("Кафе", 25, 15),
    "food": CategoryInfo("Еда", 40, 20),
    "park": CategoryInfo("Парк / сквер", 30, 10),
    "culture": CategoryInfo("Культура", 45, 20),
    "attraction": CategoryInfo("Достопримечательность", 15, 5),
    "playground": CategoryInfo("Детская площадка", 25, 10),
    "mall": CategoryInfo("Торговый центр", 40, 20),
}

MIN_VISIT_ANY = min(c.min_visit_min for c in CATEGORY_INFO.values())

FEATURE_LABELS: dict[str, str] = {
    "socket": "розетка",
    "wifi": "Wi-Fi",
    "outdoor_seating": "места на улице",
    "wheelchair": "доступность для колясок",
    "indoor": "в помещении",
    "kids": "подходит детям",
}

FEATURES: tuple[str, ...] = tuple(FEATURE_LABELS)


def category_label(category: str) -> str:
    info = CATEGORY_INFO.get(category)
    return info.label if info else category


# Interest (UI chip) -> soft category / soft feature used only for ranking.
INTEREST_CATEGORIES: dict[str, tuple[str, ...]] = {
    "coffee": ("cafe",),
    "food": ("food",),
    "nature": ("park",),
    "culture": ("culture",),
    "architecture": ("attraction",),
    "kids": ("playground",),
    "shopping": ("mall",),
    "quiet": (),
    "indoor": (),
}
INTEREST_FEATURES: dict[str, tuple[str, ...]] = {"kids": ("kids",), "indoor": ("indoor",)}
INTEREST_LABELS: dict[str, str] = {
    "coffee": "кофе",
    "food": "еда",
    "nature": "природа",
    "culture": "культура",
    "architecture": "архитектура",
    "kids": "с ребёнком",
    "quiet": "тишина",
    "indoor": "в помещении",
    "shopping": "покупки",
}
