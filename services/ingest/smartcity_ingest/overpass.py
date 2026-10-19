"""Read-only Overpass client and query groups.

Policy: one request at a time, >=2 s pause between requests, bounded retries (max 3 attempts)
with backoff, explicit User-Agent, server-side timeout. No tile requests, no OSM editing API.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass

import httpx

log = logging.getLogger("smartcity_ingest.overpass")

POI_GROUPS = ("poi_cafe_food", "poi_culture", "poi_attraction", "poi_park_playground", "poi_mall")
MAP_GROUPS = ("map_buildings", "map_roads", "map_water", "map_green", "map_landmarks")


@dataclass(frozen=True)
class QueryGroup:
    name: str
    selectors: tuple[str, ...]  # Overpass statements using {area}
    output: str  # Overpass out statement
    kind: str  # "poi" | "map"


def query_groups() -> list[QueryGroup]:
    poi_out = "out meta geom;"
    return [
        QueryGroup(
            "poi_cafe_food",
            ('nwr["amenity"~"^(cafe|ice_cream|restaurant|fast_food)$"]{area};',),
            poi_out,
            "poi",
        ),
        QueryGroup(
            "poi_culture",
            (
                'nwr["tourism"~"^(museum|gallery)$"]{area};',
                'nwr["amenity"~"^(theatre|cinema|arts_centre|library)$"]{area};',
            ),
            poi_out,
            "poi",
        ),
        QueryGroup(
            "poi_attraction",
            (
                'nwr["tourism"~"^(attraction|viewpoint|artwork)$"]{area};',
                'nwr["historic"~"^(monument|memorial)$"]{area};',
                'nwr["amenity"="fountain"]{area};',
            ),
            poi_out,
            "poi",
        ),
        QueryGroup(
            "poi_park_playground",
            ('nwr["leisure"~"^(park|garden|playground)$"]{area};',),
            poi_out,
            "poi",
        ),
        QueryGroup("poi_mall", ('nwr["shop"="mall"]{area};',), poi_out, "poi"),
        QueryGroup(
            "map_buildings",
            ('way["building"]{area};', 'relation["building"]["type"="multipolygon"]{area};'),
            "out body geom;",
            "map",
        ),
        QueryGroup("map_roads", ('way["highway"]{area};',), "out body geom;", "map"),
        QueryGroup(
            "map_water",
            (
                'way["natural"="water"]{area};',
                'relation["natural"="water"]{area};',
                'way["waterway"~"^(river|canal|stream|drain|ditch|riverbank)$"]{area};',
                'way["landuse"="reservoir"]{area};',
                'way["leisure"="swimming_area"]{area};',
            ),
            "out body geom;",
            "map",
        ),
        QueryGroup(
            "map_green",
            (
                'way["leisure"~"^(park|garden|pitch|playground|dog_park)$"]{area};',
                'relation["leisure"~"^(park|garden)$"]{area};',
                'way["landuse"~"^(grass|forest|meadow|recreation_ground|village_green|flowerbed|orchard)$"]{area};',
                'relation["landuse"~"^(grass|forest|meadow|recreation_ground)$"]{area};',
                'way["natural"~"^(wood|scrub|grassland)$"]{area};',
                'relation["natural"~"^(wood|scrub|grassland)$"]{area};',
            ),
            "out body geom;",
            "map",
        ),
        # Reference objects for landmark verification (A04) that are not POI categories.
        QueryGroup(
            "map_landmarks",
            (
                'nwr["amenity"~"^(university|college)$"]{area};',
                'nwr["name"~"EXPO|ЭКСПО|Нур Алем|Nur Alem|Нұр Әлем",i]{area};',
                'relation["highway"]["name"~"Мәңгілік Ел|Мангилик Ел"]{area};',
            ),
            "out tags center;",
            "map",
        ),
    ]


def build_query(group: QueryGroup, poly: str, timeout_s: int = 90) -> str:
    area = f'(poly:"{poly}")'
    body = "\n  ".join(sel.replace("{area}", area) for sel in group.selectors)
    return f"[out:json][timeout:{timeout_s}];\n(\n  {body}\n);\n{group.output}"


class OverpassError(Exception):
    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


@dataclass
class OverpassResult:
    raw: bytes
    data: dict
    attempts: int


class OverpassClient:
    def __init__(
        self,
        endpoint: str,
        user_agent: str,
        *,
        timeout_s: float = 150.0,
        max_attempts: int = 3,
        backoff_s: tuple[float, ...] = (10.0, 30.0),
        min_interval_s: float = 2.0,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if not endpoint.startswith("https://"):
            raise ValueError("Overpass endpoint must be https")
        self.endpoint = endpoint
        self.max_attempts = max(1, min(max_attempts, 3))
        self.backoff_s = backoff_s
        self.min_interval_s = max(2.0, min_interval_s)
        self._sleep = sleep
        self._last_request = 0.0
        self._client = httpx.Client(
            timeout=timeout_s,
            headers={"User-Agent": user_agent, "Accept": "application/json"},
            transport=transport,
        )

    def _pace(self) -> None:
        wait = self._last_request + self.min_interval_s - time.monotonic()
        if wait > 0:
            self._sleep(wait)

    def _once(self, query: str) -> OverpassResult:
        self._pace()
        try:
            resp = self._client.post(self.endpoint, data={"data": query})
        except httpx.TimeoutException as e:
            raise OverpassError("timeout", retryable=True) from e
        except httpx.HTTPError as e:
            raise OverpassError(f"transport error: {type(e).__name__}", retryable=True) from e
        finally:
            self._last_request = time.monotonic()
        if resp.status_code in (429, 502, 503, 504) or resp.status_code >= 500:
            raise OverpassError(f"HTTP {resp.status_code}", retryable=True)
        if resp.status_code >= 400:
            raise OverpassError(f"HTTP {resp.status_code}", retryable=False)
        raw = resp.content
        try:
            data = resp.json()
        except ValueError as e:
            # Overpass returns an HTML/XML page on dispatcher/runtime errors.
            raise OverpassError("non-JSON response (server runtime error)", retryable=True) from e
        remark = str(data.get("remark") or "")
        if "error" in remark.lower():
            # e.g. "runtime error: Query timed out" -> the element list is incomplete.
            raise OverpassError(f"incomplete result: {remark[:200]}", retryable=True)
        if "elements" not in data or "osm3s" not in data:
            raise OverpassError("unexpected payload", retryable=False)
        return OverpassResult(raw=raw, data=data, attempts=1)

    def run(self, query: str) -> OverpassResult:
        last: OverpassError | None = None
        for attempt in range(1, self.max_attempts + 1):
            try:
                res = self._once(query)
                res.attempts = attempt
                return res
            except OverpassError as e:
                last = e
                log.warning("overpass attempt %d/%d failed: %s", attempt, self.max_attempts, e)
                if not e.retryable or attempt == self.max_attempts:
                    break
                self._sleep(self.backoff_s[min(attempt - 1, len(self.backoff_s) - 1)])
        assert last is not None
        raise last

    def close(self) -> None:
        self._client.close()
