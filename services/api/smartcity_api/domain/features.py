"""Feature facts from the stored amenities + evidence (docs/CONTRACTS.md §2).

Only `value is True` counts as verified; `None`/missing is unknown (never assumed either way).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from smartcity_api.domain.categories import FEATURE_LABELS, FEATURES, category_label


@dataclass(frozen=True)
class FeatureState:
    feature: str
    value: bool | None
    basis: str | None
    evidence: str


@dataclass
class FeatureSummary:
    verified: list[FeatureState] = field(default_factory=list)
    negative: list[FeatureState] = field(default_factory=list)
    unknown: list[str] = field(default_factory=list)

    def value(self, feature: str) -> bool | None:
        for f in self.verified:
            if f.feature == feature:
                return True
        for f in self.negative:
            if f.feature == feature:
                return False
        return None


def summarize_features(
    amenities: dict | None, category: str, evidence_by_id: dict[int, str]
) -> FeatureSummary:
    out = FeatureSummary()
    amenities = amenities or {}
    for feat in FEATURES:
        entry = amenities.get(feat)
        if not isinstance(entry, dict):
            out.unknown.append(feat)
            continue
        value = entry.get("value")
        if value is not True and value is not False:
            out.unknown.append(feat)
            continue
        basis = entry.get("basis") if entry.get("basis") in ("tag", "category_rule") else "tag"
        ev_ids = entry.get("evidence_ids") or []
        excerpts = [evidence_by_id[i] for i in ev_ids if isinstance(i, int) and i in evidence_by_id]
        if basis == "category_rule":
            evidence = f"Правило категории: {category_label(category)} — {FEATURE_LABELS[feat]}"
            if value is False:
                evidence = f"Правило категории: {category_label(category)} — не {FEATURE_LABELS[feat]}"
        elif excerpts:
            evidence = "OSM: " + "; ".join(excerpts[:3])
        else:
            evidence = "OSM: тег объекта"
        state = FeatureState(feat, bool(value), basis, evidence)
        (out.verified if value else out.negative).append(state)
    return out
