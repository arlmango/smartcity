"""Timebox walk: 2–3 stops that fit the time budget, every leg from the pedestrian router.

Deterministic and bounded: at most MAX_CANDIDATES places (already filtered by hard constraints and
ranked), at most MAX_CALLS router calls, a stage deadline, and a brute force over at most
5 + 20 + 60 ordered sequences. No LLM is involved. A partial result is never returned as a plan.
"""

from __future__ import annotations

import time
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import timedelta
from itertools import permutations

from smartcity_api.contracts import LatLon, PlanSkip, PlanStop, RouteLeg, WalkPlan
from smartcity_api.domain.budget import buffer_minutes
from smartcity_api.domain.categories import CATEGORY_INFO, category_label
from smartcity_api.domain.hours import evaluate_opening
from smartcity_api.errors import ClientDisconnected
from smartcity_api.providers.routing import GRAPH_VERSION, RoutingError, Valhalla
from smartcity_api.providers.routing import minutes as leg_minutes

MAX_CANDIDATES = 5
MAX_STOPS = 3
MAX_CALLS = MAX_CANDIDATES * (MAX_CANDIDATES - 1)
STAGE_SECONDS = 4.0
EAT = frozenset({"cafe", "food"})
METHOD = (
    "Пешие участки — пешеходные пути по данным OpenStreetMap (4 км/ч) + подход к точкам; "
    "время на месте — типичное для категории, не факт; запас max(5 мин, 10% ходьбы)"
)


@dataclass(frozen=True)
class Stop:
    key: str
    category: str
    rank: int  # 0 = best match for the request


@dataclass
class Choice:
    order: tuple[int, ...]
    walk_min: int
    visits: list[int]
    buffer_min: int
    arrive: list[int]
    shortened: bool

    @property
    def total_min(self) -> int:
        return self.walk_min + sum(self.visits) + self.buffer_min


@dataclass
class Search:
    best: Choice | None = None
    feasible_with: set[int] = field(default_factory=set)
    min_budget_two: int | None = None  # smallest budget in which any 2-stop plan would fit
    # Why sequences were rejected: overall, and per stop (only sequences containing that stop).
    reasons: Counter[str] = field(default_factory=Counter)
    stop_reasons: dict[int, Counter[str]] = field(default_factory=dict)

    def reject(self, order: tuple[int, ...], why: str) -> None:
        self.reasons[why] += 1
        for i in order:
            self.stop_reasons.setdefault(i, Counter())[why] += 1


# Most informative first: a time problem is reported only when time really was the obstacle.
REASON_ORDER = ("budget", "closed", "no_path", "category")
STOP_REASON = {
    "budget": "Не помещается в {budget} мин вместе с другими остановками",
    "closed": "Будет закрыто к моменту прихода по плану",
    "no_path": "Нет проверенного пешего пути от других мест плана",
    "category": "В плане уже есть место, где можно поесть",
}


def plan_reachable(timing, budget: int) -> bool:
    """A stop is worth planning around when its own walking leaves 40% of the budget."""
    return (timing.outbound_min + (timing.return_min or 0)) * 10 <= budget * 6


def allocate_visits(cats: list[str], available: int) -> tuple[list[int], bool] | None:
    """Typical visits when they fit; otherwise top up category minimums in stop order."""
    infos = [CATEGORY_INFO[c] for c in cats]
    if available >= sum(i.default_visit_min for i in infos):
        return [i.default_visit_min for i in infos], False
    extra = available - sum(i.min_visit_min for i in infos)
    if extra < 0:
        return None
    visits = []
    for i in infos:
        add = min(extra, i.default_visit_min - i.min_visit_min)
        visits.append(i.min_visit_min + add)
        extra -= add
    return visits, True


def category_ok(cats: list[str]) -> bool:
    return sum(c in EAT for c in cats) <= 1 and all(cats.count(c) <= 2 for c in set(cats))


def choose(
    stops: list[Stop],
    leg: Callable[[int | None, int | None], int | None],
    *,
    budget: int,
    back: bool,
    open_ok: Callable[[int, int, int], bool] = lambda i, arrive, visit: True,
) -> Search:
    """Best feasible ordered sequence of 2..MAX_STOPS stops.

    leg(a, b) returns walking minutes between stops (None = start) or None when no verified path.
    Objective: highest summed match value (rank 0 is worth len(stops)); ties -> less walking,
    then better ranks in order. Fully deterministic.
    """
    out = Search()
    n = len(stops)
    best_key = None
    for size in range(2, min(MAX_STOPS, n) + 1):
        for order in permutations(range(n), size):
            cats = [stops[i].category for i in order]
            if not category_ok(cats):
                out.reject(order, "category")
                continue
            hops = [leg(None, order[0])] + [leg(a, b) for a, b in zip(order, order[1:], strict=False)]
            if back:
                hops.append(leg(order[-1], None))
            if any(h is None for h in hops):
                out.reject(order, "no_path")
                continue
            walk = sum(h for h in hops if h is not None)
            buffer = buffer_minutes(walk, None)
            if size == 2:
                need = walk + buffer + sum(CATEGORY_INFO[c].min_visit_min for c in cats)
                out.min_budget_two = need if out.min_budget_two is None else min(out.min_budget_two, need)
            alloc = allocate_visits(cats, budget - walk - buffer)
            if alloc is None:
                out.reject(order, "budget")
                continue
            visits, shortened = alloc
            arrive, clock = [], 0
            for k in range(size):
                clock += hops[k] or 0
                arrive.append(clock)
                clock += visits[k]
            if not all(open_ok(i, arrive[k], visits[k]) for k, i in enumerate(order)):
                out.reject(order, "closed")
                continue
            choice = Choice(order, walk, visits, buffer, arrive, shortened)
            assert choice.total_min <= budget
            out.feasible_with.update(order)
            value = sum(n - stops[i].rank for i in order)
            key = (-value, walk, tuple(stops[i].rank for i in order))
            if best_key is None or key < best_key:
                best_key, out.best = key, choice
    return out


def main_reason(counts: Counter[str] | None) -> str | None:
    return next((r for r in REASON_ORDER if counts and counts[r]), None)


def no_plan_note(search: Search, *, budget: int, back: bool) -> str:
    """Name the obstacle that actually stopped every 2–3 stop plan."""
    why = main_reason(search.reasons)
    if why == "budget":
        need = search.min_budget_two
        return (
            f"В {budget} мин не помещаются две остановки{' с возвратом к старту' if back else ''}"
            + (f" — нужно хотя бы {need} мин." if need and need > budget else ".")
            + " Выберите одно место из вариантов ниже или увеличьте время."
        )
    if why == "closed":
        return "По плану к приходу часть мест будет закрыта — выберите одно место из вариантов ниже."
    if why == "no_path":
        return "Между найденными местами нет проверенных пеших путей — выберите одно место из вариантов ниже."
    return (
        "Подходят только места, где можно поесть, а в плане может быть одно такое — "
        "выберите одно из вариантов ниже."
    )


def explain(choice: Choice, stops: list[Stop], search: Search, names: list[str], *, budget: int, back: bool):
    why = [
        f"Места выбраны из лучших совпадений с запросом так, чтобы вместе уложиться в {budget} мин.",
        f"Пешком ≈ {choice.walk_min} мин{' с возвратом к старту' if back else ''}, "
        f"на местах ≈ {sum(choice.visits)} мин, запас {choice.buffer_min} мин.",
    ]
    if choice.shortened:
        why.append("Время на местах короче типичного, чтобы уложиться в бюджет.")
    chosen_cats = [stops[i].category for i in choice.order]
    skipped = []
    for i, s in enumerate(stops):
        if i in choice.order:
            continue
        if i not in search.feasible_with:
            reason = STOP_REASON[main_reason(search.stop_reasons.get(i)) or "budget"].format(budget=budget)
        elif s.category in EAT and any(c in EAT for c in chosen_cats):
            reason = "В плане уже есть место, где можно поесть"
        else:
            reason = "Есть план с этим местом, но выбранные лучше подходят к запросу"
        skipped.append(PlanSkip(place_id=s.key, name=names[i], reason=reason))
    return why, skipped


def build_plan(container, prep, cands) -> None:
    """Fill prep.plan / prep.plan_note. cands: ranked candidates with router legs from the start."""
    eff = prep.eff
    if container.settings.routing_provider != "valhalla":
        prep.plan_note = (
            "План из нескольких остановок доступен только с пешеходными маршрутами — они не подключены."
        )
        return
    if not prep.routing_ok:
        prep.plan_note = "Пешеходные маршруты сейчас недоступны — план из нескольких остановок не построен."
        return
    pool = [c for c in cands if c.route is not None][:MAX_CANDIDATES]
    if len(pool) < 2:
        prep.plan_note = "Для плана из нескольких остановок нашлось меньше двух подходящих мест."
        return
    started = time.monotonic()
    deadline = min(prep.deadline, started + STAGE_SECONDS)
    pts = [LatLon(lat=c.place.lat, lon=c.place.lon) for c in pool]
    between: dict[tuple[int, int], RouteLeg | None] = {}
    router = None
    try:
        router = Valhalla(container.settings.routing_base_url)
        for a, b in permutations(range(len(pool)), 2):
            if prep.cancelled.is_set():
                raise ClientDisconnected()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RoutingError("deadline")
            try:
                between[(a, b)] = router.legs([pts[a], pts[b]], timeout=min(2, remaining))[0]
            except RoutingError as exc:
                if exc.code not in {"no_path", "unverified_access", "outside_coverage"}:
                    raise
                between[(a, b)] = None
    except RoutingError:
        prep.plan_note = (
            "Не удалось проверить пешие пути между местами — план не построен, смотрите варианты ниже."
        )
        return
    finally:
        if router:
            router.close()
        prep.timings["plan_routing"] = round((time.monotonic() - started) * 1000)

    def leg_of(a: int | None, b: int | None) -> RouteLeg | None:
        if a is None and b is not None:
            return pool[b].route.outbound
        if b is None and a is not None:
            return pool[a].route.return_leg
        return between.get((a, b))  # type: ignore[arg-type]

    def leg_min(a: int | None, b: int | None) -> int | None:
        found = leg_of(a, b)
        return leg_minutes(found) if found else None

    def open_ok(i: int, arrive: int, visit: int) -> bool:
        status = evaluate_opening(
            pool[i].place.opening_hours_raw, prep.start_time + timedelta(minutes=arrive), visit
        ).status
        return status != "closed" and (status == "open" or not eff.must_be_open[0])

    stops = [Stop(key=c.place.pid, category=c.place.category, rank=r) for r, c in enumerate(pool)]
    budget, back = eff.time_budget_min, eff.return_to_start
    search = choose(stops, leg_min, budget=budget, back=back, open_ok=open_ok)
    best = search.best
    if best is None:
        prep.plan_note = no_plan_note(search, budget=budget, back=back)
        return
    names = [
        f"{category_label(c.place.category)} без названия" if c.place.name_is_generic else c.place.name
        for c in pool
    ]
    why, skipped = explain(best, stops, search, names, budget=budget, back=back)
    plan_stops = []
    for k, i in enumerate(best.order):
        p = pool[i].place
        leg_in = leg_of(None if k == 0 else best.order[k - 1], i)
        assert leg_in is not None
        plan_stops.append(
            PlanStop(
                place_id=p.pid,
                name=p.name,
                name_is_generic=p.name_is_generic,
                category=p.category,  # type: ignore[arg-type]
                category_label=category_label(p.category),
                coordinates=LatLon(lat=p.lat, lon=p.lon),
                leg_in=leg_in,
                arrive_min=best.arrive[k],
                visit_min=best.visits[k],
                opening_status=evaluate_opening(  # type: ignore[arg-type]
                    p.opening_hours_raw, prep.start_time + timedelta(minutes=best.arrive[k]), best.visits[k]
                ).status,
            )
        )
    ret = leg_of(best.order[-1], None) if back else None
    legs = [s.leg_in for s in plan_stops] + ([ret] if ret else [])
    prep.plan = WalkPlan(
        stops=plan_stops,
        return_leg=ret,
        graph_version=GRAPH_VERSION,
        time_budget_min=budget,
        walk_min=best.walk_min,
        visit_min=sum(best.visits),
        buffer_min=best.buffer_min,
        total_min=best.total_min,
        distance_m=sum(leg.distance_m for leg in legs),
        returns_to_start=back,
        why=why,
        skipped=skipped,
        method=METHOD,
    )
