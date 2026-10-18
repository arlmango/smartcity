"""/api/health, /api/ready, /api/coverage, /api/map/{layer}, /api/route."""

from __future__ import annotations

import hashlib
import json
import threading
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel
from sqlalchemy import text

from smartcity_api.contracts import ComponentStatus, CoverageResponse, ErrorResponse, LatLon, ReadyResponse
from smartcity_api.errors import ApiError
from smartcity_api.retrieval import repository as repo
from smartcity_api.retrieval.landmarks import load_landmark
from smartcity_api.runtime import Container

router = APIRouter(prefix="/api")

# Whitelist (docs/CONTRACTS.md §7). The file name comes from this table, never from the request.
MAP_LAYERS: dict[str, str] = {
    "buildings": "buildings.geojson",
    "roads": "roads.geojson",
    "water": "water.geojson",
    "green": "green.geojson",
    "coverage": "coverage.geojson",
}

DEMO_ORIGIN_PATTERNS = ["%Нур Алем%", "%Nur Alem%", "%Нұр Әлем%", "%EXPO%", "%ЭКСПО%", "%Экспо%"]


def container_of(request: Request) -> Container:
    return request.app.state.container


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", service="smartcity-api", version="0.1.0")


def _map_status(data_dir: Path) -> ComponentStatus:
    present = [k for k, f in MAP_LAYERS.items() if (data_dir / "map" / f).is_file()]
    if len(present) == len(MAP_LAYERS):
        return ComponentStatus(status="ok", detail="Слои карты: " + ", ".join(present))
    if present:
        missing = [k for k in MAP_LAYERS if k not in present]
        return ComponentStatus(status="degraded", detail="Нет слоёв: " + ", ".join(missing))
    return ComponentStatus(status="unavailable", detail="Файлы слоёв карты не найдены")


@router.get(
    "/ready",
    response_model=ReadyResponse,
    responses={503: {"model": ReadyResponse, "description": "Not ready (db/data/map)"}},
)
def ready(request: Request) -> JSONResponse:
    c = container_of(request)
    comps: dict[str, ComponentStatus] = {}
    stats: list[repo.IndexStat] = []
    try:
        with c.sessionmaker() as s:
            s.execute(text("SELECT 1"))
            comps["db"] = ComponentStatus(status="ok", detail="PostgreSQL доступна")
            n = repo.count_active_places(s)
            cov = repo.load_coverage(s)
            stats = repo.index_stats(s)
        if n > 0 and cov:
            comps["data"] = ComponentStatus(
                status="ok", detail=f"Активных мест: {n}; версия данных {cov[0].dataset_version}"
            )
        else:
            comps["data"] = ComponentStatus(
                status="unavailable",
                detail=f"Активных мест: {n}; покрытие {'есть' if cov else 'отсутствует'}",
            )
    except Exception as e:
        comps["db"] = ComponentStatus(
            status="unavailable", detail=f"Нет соединения с БД ({type(e).__name__})"
        )
        comps["data"] = ComponentStatus(status="unavailable", detail="БД недоступна")

    comps["map"] = _map_status(c.settings.data_dir)

    if c.embedder is None:
        comps["embeddings"] = ComponentStatus(status="not_configured", detail="EMBEDDING_PROVIDER=none")
    else:
        ident, err = c.probes.get("embedding", c.embedder)
        if ident is None:
            comps["embeddings"] = ComponentStatus(status="unavailable", detail=f"Probe не прошёл: {err}")
        else:
            mine = [st for st in stats if st.model_id == ident.model_id and st.dim == ident.dim]
            if mine:
                comps["embeddings"] = ComponentStatus(
                    status="ok",
                    detail=f"{ident.model_id}, dim {ident.dim}; в индексе {mine[0].count} "
                    f"(актуальных {mine[0].fresh})",
                )
            else:
                found = ", ".join(f"{st.model_id} dim {st.dim}" for st in stats[:3]) or "индекс пуст"
                comps["embeddings"] = ComponentStatus(
                    status="degraded",
                    detail=f"Модель {ident.model_id} dim {ident.dim} не совпадает с индексом ({found})",
                )
    if c.generator is None:
        comps["llm"] = ComponentStatus(status="not_configured", detail="AI_PROVIDER=none")
    else:
        ident, err = c.probes.get("llm", c.generator)
        if ident is None:
            comps["llm"] = ComponentStatus(status="unavailable", detail=f"Probe не прошёл: {err}")
        else:
            digest = f"@{ident.digest[:12]}" if ident.digest else ""
            comps["llm"] = ComponentStatus(status="ok", detail=f"{ident.provider}:{ident.model}{digest}")
    if c.settings.routing_provider == "none":
        comps["routing"] = ComponentStatus(
            status="not_configured", detail="ROUTING_PROVIDER=none: расстояния по прямой (оценка)"
        )
    else:
        comps["routing"] = ComponentStatus(status="unavailable", detail="Маршрутизатор не поддержан в v1")
    is_ready = all(comps[k].status == "ok" for k in ("db", "data", "map"))
    body = ReadyResponse(ready=is_ready, components=comps)
    return JSONResponse(body.model_dump(), status_code=200 if is_ready else 503)


def _config_coverage(path: Path) -> tuple[list[dict], list[float]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return [], [0.0, 0.0, 0.0, 0.0]
    feats = [f for f in data.get("features", []) if isinstance(f, dict)]
    xs, ys = [], []
    for f in feats:
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates") or []
        rings = coords if geom.get("type") == "Polygon" else [r for poly in coords for r in poly]
        for ring in rings:
            for x, y in ring:
                xs.append(x)
                ys.append(y)
    bbox = [min(xs), min(ys), max(xs), max(ys)] if xs else [0.0, 0.0, 0.0, 0.0]
    return feats, bbox


@router.get("/coverage", response_model=CoverageResponse)
def coverage(request: Request) -> CoverageResponse:
    c = container_of(request)
    with c.sessionmaker() as s:
        rows = repo.load_coverage(s)
        demo = repo.find_place_by_names(s, DEMO_ORIGIN_PATTERNS) if rows else None
    if rows:
        features = [
            {
                "type": "Feature",
                "id": r.id,
                "properties": {"id": r.id, "name": r.name, "dataset_version": r.dataset_version},
                "geometry": r.geometry,
            }
            for r in rows
        ]
        xs0, ys0 = min(r.bbox[0] for r in rows), min(r.bbox[1] for r in rows)
        xs1, ys1 = max(r.bbox[2] for r in rows), max(r.bbox[3] for r in rows)
        bbox = [xs0, ys0, xs1, ys1]
        version, count = rows[0].dataset_version, sum(r.place_count for r in rows)
        freshness, updated = rows[0].freshness, rows[0].updated_at
    else:
        features, bbox = _config_coverage(c.settings.coverage_config)
        version, count, freshness, updated = "none", 0, None, None
    lm = None if demo is not None else load_landmark(c.settings.data_dir, ["nur_alem", "expo_site"])
    if demo is not None:
        origin = LatLon(lat=demo.lat, lon=demo.lon)
        label = f"{demo.name}, район EXPO"
    elif lm is not None:
        origin = LatLon(lat=lm.lat, lon=lm.lon)
        label = f"{lm.name}, район EXPO (OSM {lm.osm})"
    else:
        origin = LatLon(lat=(bbox[1] + bbox[3]) / 2, lon=(bbox[0] + bbox[2]) / 2)
        label = "центр района покрытия"
    return CoverageResponse(
        features=features,
        dataset_version=version,
        place_count=count,
        freshness=freshness,
        updated_at=updated,
        bbox=bbox,
        default_origin=origin,
        default_origin_label=label,
    )


class _EtagCache:
    def __init__(self) -> None:
        self._d: dict[Path, tuple[int, int, str]] = {}
        self._lock = threading.Lock()

    def get(self, path: Path) -> str:
        st = path.stat()
        with self._lock:
            hit = self._d.get(path)
            if hit and hit[0] == st.st_mtime_ns and hit[1] == st.st_size:
                return hit[2]
        h = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        etag = f'"{h.hexdigest()}"'
        with self._lock:
            self._d[path] = (st.st_mtime_ns, st.st_size, etag)
        return etag


_etags = _EtagCache()


def _etag_matches(header: str | None, etag: str) -> bool:
    if not header:
        return False
    if header.strip() == "*":
        return True
    for tag in header.split(","):
        tag = tag.strip()
        if tag.startswith("W/"):
            tag = tag[2:]
        if tag == etag:
            return True
    return False


@router.get(
    "/map/{layer}",
    responses={
        200: {"content": {"application/geo+json": {}}, "description": "GeoJSON FeatureCollection"},
        304: {"description": "Not modified"},
        404: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
    },
)
def map_layer(layer: str, request: Request) -> Response:
    c = container_of(request)
    filename = MAP_LAYERS.get(layer)
    if filename is None:
        raise ApiError(404, "unknown_layer", "Неизвестный слой карты")
    path = (c.settings.data_dir / "map" / filename).resolve()
    base = (c.settings.data_dir / "map").resolve()
    if path.parent != base or not path.is_file():
        raise ApiError(503, "map_unavailable", "Слой карты ещё не подготовлен")
    etag = _etags.get(path)
    headers = {
        "ETag": etag,
        "Cache-Control": f"public, max-age={c.settings.map_cache_max_age_seconds}, must-revalidate",
    }
    if _etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers=headers)
    return FileResponse(path, media_type="application/geo+json", headers=headers)


@router.post("/route", status_code=501, responses={501: {"model": ErrorResponse}})
def route() -> JSONResponse:
    raise ApiError(
        501,
        "routing_unavailable",
        "Пешеходный маршрутизатор не подключён (ROUTING_PROVIDER=none). Расстояния показываются по прямой, "
        "линии маршрута не строятся.",
    )
