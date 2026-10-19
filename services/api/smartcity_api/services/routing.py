"""Routing before hard budgets/ranking. Bounded and isolated per request."""

import time

from smartcity_api.contracts import LatLon, Warning
from smartcity_api.errors import ClientDisconnected
from smartcity_api.providers.routing import RoutingError, Valhalla

MAX_CALLS = 256
STAGE_SECONDS = 8.0


def route_candidates(container, prep, pool):
    if container.settings.routing_provider != "valhalla" or not pool:
        return
    started = time.monotonic()
    deadline = min(prep.deadline, started + STAGE_SECONDS)
    router = None
    try:
        router = Valhalla(container.settings.routing_base_url)
        for i, c in enumerate(pool):
            if prep.cancelled.is_set():
                raise ClientDisconnected()
            remaining = deadline - time.monotonic()
            if remaining <= 0 or i >= MAX_CALLS:
                raise RoutingError("deadline")
            try:
                c.route = router.route(
                    prep.req.origin,
                    LatLon(lat=c.place.lat, lon=c.place.lon),
                    prep.eff.return_to_start,
                    timeout=min(2, remaining),
                )
                c.distance_m = c.route.outbound.distance_m
            except RoutingError as exc:
                if exc.code in {"no_path", "unverified_access", "outside_coverage"}:
                    c.routing_exclusion = exc.code
                else:
                    raise
        prep.routing_ok = True
        if any(c.routing_exclusion for c in pool):
            prep.warnings.append(
                Warning(
                    code="routing_excluded",
                    message=(
                        "Некоторые места исключены: нет подтверждённого пути в графе "
                        "или подход к сети больше 100 м."
                    ),
                )
            )
    except RoutingError:
        # Drop every partially computed result so one response never silently mixes methods.
        from smartcity_api.domain.budget import haversine_m

        for c in pool:
            c.route = None
            c.routing_exclusion = None
            c.distance_m = haversine_m(prep.req.origin.lat, prep.req.origin.lon, c.place.lat, c.place.lon)
        prep.warnings.append(
            Warning(
                code="routing_unavailable",
                message=(
                    "Пешеходный граф недоступен или проверка не завершена. "
                    "Показаны оценки по прямой; линии маршрута нет."
                ),
            )
        )
    finally:
        if router:
            router.close()
        prep.timings["routing"] = round((time.monotonic() - started) * 1000)
