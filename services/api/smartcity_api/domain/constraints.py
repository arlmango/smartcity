"""Merge UI controls (source of truth) with deterministic text markers into hard constraints."""

from __future__ import annotations

from dataclasses import dataclass, field

from smartcity_api.contracts import AppliedConstraint, Constraints, RecommendRequest
from smartcity_api.domain.categories import (
    FEATURE_LABELS,
    INTEREST_CATEGORIES,
    INTEREST_FEATURES,
    INTEREST_LABELS,
    category_label,
)
from smartcity_api.domain.parser import NEAR_RADIUS_M, ParsedQuery

# Categories whose indoor value is false by category rule (CONTRACTS §2).
OUTDOOR_CATEGORIES = {"park", "playground"}


@dataclass
class Effective:
    time_budget_min: int
    return_to_start: bool
    required_features: dict[str, str] = field(default_factory=dict)  # feature -> source
    preferred_features: list[str] = field(default_factory=list)
    include_categories: dict[str, str] = field(default_factory=dict)  # category -> source
    exclude_categories: dict[str, str] = field(default_factory=dict)
    must_be_open: tuple[bool, str] = (False, "ui")
    max_distance_m: tuple[int | None, str] = (None, "ui")
    exclude_place_ids: list[str] = field(default_factory=list)
    soft_categories: list[str] = field(default_factory=list)
    quiet: bool = False
    conflicts: list[str] = field(default_factory=list)  # Russian clarification questions
    notes: list[tuple[str, str]] = field(default_factory=list)  # (code, Russian message)

    def applied(self) -> list[AppliedConstraint]:
        out = [
            AppliedConstraint(
                kind="time_budget",
                value=self.time_budget_min,
                source="ui",
                label=f"Время: не более {self.time_budget_min} мин",
            ),
            AppliedConstraint(
                kind="return_to_start",
                value=self.return_to_start,
                source="ui",
                label="С возвращением в точку старта" if self.return_to_start else "Без возвращения",
            ),
            AppliedConstraint(kind="walking_only", value=True, source="ui", label="Только пешком"),
        ]
        for feat, src in self.required_features.items():
            out.append(
                AppliedConstraint(
                    kind="required_feature",
                    value=feat,
                    source=src,  # type: ignore[arg-type]
                    label=f"Обязательно: {FEATURE_LABELS[feat]}",
                )
            )
        for cat, src in self.include_categories.items():
            out.append(
                AppliedConstraint(
                    kind="include_category",
                    value=cat,
                    source=src,  # type: ignore[arg-type]
                    label=f"Только: {category_label(cat)}",
                )
            )
        for cat, src in self.exclude_categories.items():
            out.append(
                AppliedConstraint(
                    kind="exclude_category",
                    value=cat,
                    source=src,  # type: ignore[arg-type]
                    label=f"Без: {category_label(cat)}",
                )
            )
        if self.must_be_open[0]:
            out.append(
                AppliedConstraint(
                    kind="must_be_open",
                    value=True,
                    source=self.must_be_open[1],  # type: ignore[arg-type]
                    label="Открыто на всё время посещения (неизвестные часы исключены)",
                )
            )
        if self.max_distance_m[0] is not None:
            out.append(
                AppliedConstraint(
                    kind="max_distance",
                    value=self.max_distance_m[0],
                    source=self.max_distance_m[1],  # type: ignore[arg-type]
                    label=f"Не дальше {self.max_distance_m[0]} м по прямой",
                )
            )
        return out

    def preference_labels(self, interests: list[str]) -> list[str]:
        labels: list[str] = []
        for f in self.preferred_features:
            labels.append(f"Желательно: {FEATURE_LABELS[f]} (учитывается только если подтверждено)")
        if self.quiet:
            labels.append("Тишина (в данных OSM не проверяется)")
        for c in self.soft_categories:
            labels.append(f"Интерес: {category_label(c)}")
        for i in interests:
            lab = f"Интерес: {INTEREST_LABELS.get(i, i)}"
            if lab not in labels and i not in ("quiet",):
                labels.append(lab)
        return labels

    def to_constraints(self) -> Constraints:
        """Full constraints object as the client should resend it (used for relaxation patches)."""
        return Constraints(
            required_features=list(self.required_features),  # type: ignore[arg-type]
            preferred_features=list(self.preferred_features),  # type: ignore[arg-type]
            include_categories=list(self.include_categories),  # type: ignore[arg-type]
            exclude_categories=list(self.exclude_categories),  # type: ignore[arg-type]
            must_be_open=self.must_be_open[0],
            max_distance_m=self.max_distance_m[0],
            exclude_place_ids=list(self.exclude_place_ids),
        )


def merge(req: RecommendRequest, parsed: ParsedQuery) -> Effective:
    ui = req.constraints
    eff = Effective(time_budget_min=req.time_budget_min, return_to_start=req.return_to_start)

    for uf in ui.required_features:
        eff.required_features[uf] = "ui"
    for f in parsed.required_features:
        # UI explicitly marked it as a mere preference (e.g. after a relaxation) -> UI wins.
        if f not in eff.required_features and f not in ui.preferred_features:
            eff.required_features[f] = "text"
    prefs: list[str] = []
    for pf in [*ui.preferred_features, *parsed.preferred_features]:
        if pf not in eff.required_features and pf not in prefs:
            prefs.append(pf)
    for interest in req.interests:
        for f in INTEREST_FEATURES.get(interest, ()):
            if f not in eff.required_features and f not in prefs:
                prefs.append(f)
    eff.preferred_features = prefs

    for uc in ui.include_categories:
        eff.include_categories[uc] = "ui"
    for c in parsed.include_categories:
        eff.include_categories.setdefault(c, "text")
    for ue in ui.exclude_categories:
        eff.exclude_categories[ue] = "ui"
    for c in parsed.exclude_categories:
        eff.exclude_categories.setdefault(c, "text")

    if ui.must_be_open:
        eff.must_be_open = (True, "ui")
    elif parsed.must_be_open:
        eff.must_be_open = (True, "text")

    if ui.max_distance_m is not None:
        eff.max_distance_m = (ui.max_distance_m, "ui")
    elif parsed.near:
        eff.max_distance_m = (NEAR_RADIUS_M, "text")

    eff.exclude_place_ids = list(ui.exclude_place_ids)

    soft: list[str] = []
    for c in parsed.soft_categories:
        if c not in soft:
            soft.append(c)
    for interest in req.interests:
        for c in INTEREST_CATEGORIES.get(interest, ()):
            if c not in soft:
                soft.append(c)
    eff.soft_categories = [c for c in soft if c not in eff.exclude_categories]
    eff.quiet = parsed.quiet or "quiet" in req.interests

    # UI has priority over text for budget/return; surface the discrepancy honestly.
    if parsed.budget_min is not None and parsed.budget_min != req.time_budget_min:
        eff.notes.append(
            (
                "text_budget_ignored",
                f"В тексте указано {parsed.budget_min} мин, использовано значение из настроек: "
                f"{req.time_budget_min} мин",
            )
        )
    if parsed.return_hint is not None and parsed.return_hint != req.return_to_start:
        eff.notes.append(
            (
                "text_return_ignored",
                "Текст и переключатель «вернуться» расходятся; использован переключатель",
            )
        )

    # Conflicts between explicit hard conditions -> needs_clarification.
    both = [c for c in eff.include_categories if c in eff.exclude_categories]
    for c in both:
        eff.conflicts.append(
            f"Вы просите одновременно «только {category_label(c).lower()}» и «без "
            f"{category_label(c).lower()}». Какое условие оставить?"
        )
    if "indoor" in eff.required_features and eff.include_categories:
        remaining = [c for c in eff.include_categories if c not in eff.exclude_categories]
        if remaining and all(c in OUTDOOR_CATEGORIES for c in remaining):
            eff.conflicts.append(
                "Вы просите «только внутри», но выбранные категории ("
                + ", ".join(category_label(c) for c in remaining)
                + ") находятся под открытым небом. Что важнее: помещение или категория?"
            )
    return eff
