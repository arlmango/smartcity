"""Bounded local Valhalla adapter; never fabricates a path on failure."""

from __future__ import annotations

import math
from urllib.parse import urlsplit

import httpx
from pydantic import ValidationError

from smartcity_api.contracts import LatLon, RouteGeometry, RouteLeg, WalkingRoute
from smartcity_api.domain.budget import haversine_m

BBOX = (71.35, 51.04, 71.48, 51.15)
GRAPH_VERSION = "astana-20261018-valhalla-3.8.3"
NOTE = (
    "Пешеходный путь Valhalla по OSM от 18.10.2026. Время приблизительное, 4 км/ч. "
    "Доступность проходов сейчас не проверена. Линия заканчивается на дорожной сети: "
    "подход к точке/входу оценён отдельно и не подтверждён; проход внутри здания не построен."
)
TIMING = "Оценка Valhalla, пешком 4 км/ч + подход к сети; возврат рассчитан отдельно; запас и типичный визит"


class RoutingError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def covered(point: LatLon) -> bool:
    return BBOX[0] <= point.lon <= BBOX[2] and BBOX[1] <= point.lat <= BBOX[3]


def minutes(leg: RouteLeg) -> int:
    return math.ceil(leg.duration_s / 60) + leg.access_estimate_min


def decode_shape(shape):
    if not isinstance(shape, str):
        return shape
    if len(shape) > 200000:
        raise RoutingError("malformed")
    coords, values = [], [0, 0]
    pos = 0
    while pos < len(shape):
        for axis in range(2):
            number, shift = 0, 0
            while True:
                if pos >= len(shape) or shift > 30:
                    raise RoutingError("malformed")
                byte = ord(shape[pos]) - 63
                pos += 1
                if not 0 <= byte <= 63:
                    raise RoutingError("malformed")
                number |= (byte & 31) << shift
                shift += 5
                if byte < 32:
                    break
            values[axis] += ~(number >> 1) if number & 1 else number >> 1
        coords.append((values[1] / 1e6, values[0] / 1e6))
    return {"type": "LineString", "coordinates": coords}


def _leg(raw: dict, start: LatLon, end: LatLon) -> RouteLeg:
    geom = RouteGeometry.model_validate(decode_shape(raw["shape"]))
    if any(not covered(LatLon(lon=x, lat=y)) for x, y in geom.coordinates):
        raise RoutingError("outside_coverage")
    a, b = geom.coordinates[0], geom.coordinates[-1]
    gaps = [haversine_m(start.lat, start.lon, a[1], a[0]), haversine_m(end.lat, end.lon, b[1], b[0])]
    if max(gaps) > 100:
        raise RoutingError("unverified_access")
    distance, duration = raw["summary"]["length"] * 1000, raw["summary"]["time"]
    if not all(isinstance(v, (float, int)) and math.isfinite(v) and v >= 0 for v in (distance, duration)):
        raise RoutingError("malformed")
    return RouteLeg(
        geometry=geom,
        distance_m=math.ceil(distance),
        duration_s=math.ceil(duration),
        start_snap_m=math.ceil(gaps[0]),
        end_snap_m=math.ceil(gaps[1]),
        access_estimate_min=0 if start == end and distance == 0 else math.ceil(sum(gaps) / (4000 / 60)),
    )


class Valhalla:
    def __init__(self, base_url: str, *, timeout: float = 2.0):
        # This pilot is deliberately local: coordinates must not leave the machine.
        u = urlsplit(base_url)
        if u.scheme != "http" or u.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise RoutingError("not_local")
        self.client = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout, trust_env=False)

    def close(self):
        self.client.close()

    def route(self, start: LatLon, end: LatLon, back: bool, *, timeout: float = 2.0) -> WalkingRoute:
        if not covered(start) or not covered(end):
            raise RoutingError("outside_coverage")
        points = [start, end, start] if back else [start, end]
        try:
            response = self.client.post(
                "/route",
                timeout=timeout,
                json={
                    "locations": [
                        {**p.model_dump(), "type": "break", "radius": 100, "search_cutoff": 100}
                        for p in points
                    ],
                    "costing": "pedestrian",
                    "costing_options": {"pedestrian": {"walking_speed": 4}},
                    "units": "kilometers",
                    "shape_format": "geojson",
                },
            )
            data = response.json()
            if response.status_code != 200:
                code = data.get("error_code")
                raise RoutingError("no_path" if code in {171, 442, 443, 444} else "unavailable")
            trip = data["trip"]
            if trip["status"] != 0 or len(trip["legs"]) != len(points) - 1:
                raise RoutingError("malformed")
            legs = [_leg(raw, points[i], points[i + 1]) for i, raw in enumerate(trip["legs"])]
            return WalkingRoute(
                graph_version=GRAPH_VERSION, outbound=legs[0], return_leg=legs[1] if back else None, note=NOTE
            )
        except (httpx.HTTPError, ValueError, KeyError, TypeError, ValidationError) as exc:
            raise RoutingError("unavailable" if isinstance(exc, httpx.HTTPError) else "malformed") from None
