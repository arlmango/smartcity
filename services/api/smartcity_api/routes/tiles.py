"""/api/tiles/{tileset}/{z}/{x}/{y}: vector tiles of the city-wide base map (docs/CONTRACTS.md §7a).

Tiles are read from local PMTiles archives in DATA_DIR/basemap (built by `make basemap`), so
the browser loads only the visible area. The archive name comes from a whitelist, never from
the request. Tiles are returned uncompressed (`application/x-protobuf`): the web proxy may
re-encode, and a gzip body with a forwarded Content-Encoding would break behind it.
"""

from __future__ import annotations

import gzip
import json
import threading
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response
from pmtiles.reader import MmapSource, Reader
from pmtiles.tile import Compression, zxy_to_tileid

from smartcity_api.contracts import ErrorResponse
from smartcity_api.errors import ApiError

router = APIRouter(prefix="/api")

# Satellite underlay for the hybrid view (browser fetches EOX directly; never proxied or cached here).
EOX_SATELLITE = {
    "tiles": ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg"],
    "maxzoom": 14,
    "attribution": (
        '<a href="https://cloudless.eox.at" target="_blank" rel="noopener noreferrer">'
        "EOxCloudless https://cloudless.eox.at</a> by EOX IT Services GmbH "
        "(Contains modified Copernicus Sentinel data 2024), colours adjusted by SmartCity · "
        '<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" '
        'rel="noopener noreferrer">CC BY-NC-SA 4.0</a>'
    ),
    "license": "CC BY-NC-SA 4.0 (EOxCloudless 2018–2025, non-commercial use only)",
    "license_url": "https://cloudless.eox.at/license-non-commercial/",
    "resolution_m": 10,
}
BOUNDARY_FILE = "astana-boundary.geojson"
NO_HEIGHTS = {"height": 0, "levels": 0, "estimate": 0, "default": 0}

TILESETS: dict[str, str] = {
    "base": "astana-base.pmtiles",
    "buildings": "astana-buildings.pmtiles",
}
MAX_TILE_ZOOM = 15


class _Archive:
    def __init__(self, path: Path) -> None:
        st = path.stat()
        self.key = (st.st_mtime_ns, st.st_size)
        self._f = path.open("rb")
        self.reader = Reader(MmapSource(self._f))  # MmapSource maps the open file read-only
        self.header = self.reader.header()
        self.etag_base = f"{st.st_size:x}-{st.st_mtime_ns:x}"

    def close(self) -> None:
        self._f.close()


class _Archives:
    """Open archives once; reopen when the file on disk is replaced by a rebuild."""

    def __init__(self) -> None:
        self._d: dict[Path, _Archive] = {}
        self._lock = threading.Lock()

    def get(self, path: Path) -> _Archive | None:
        try:
            st = path.stat()
        except FileNotFoundError:
            return None
        with self._lock:
            a = self._d.get(path)
            if a and a.key == (st.st_mtime_ns, st.st_size):
                return a
            if a:
                a.close()
            a = _Archive(path)
            self._d[path] = a
            return a


_archives = _Archives()


def basemap_dir(request: Request) -> Path:
    return request.app.state.container.settings.data_dir / "basemap"


@router.get(
    "/tiles/{tileset}/{z}/{x}/{y}",
    responses={
        200: {"content": {"application/x-protobuf": {}}, "description": "Mapbox Vector Tile"},
        204: {"description": "No data in this tile"},
        304: {"description": "Not modified"},
        404: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
    },
)
def tile(
    tileset: str,
    z: int,
    x: int,
    y: int,
    request: Request,
    v: Annotated[str | None, Query(pattern=r"^[0-9a-f]{1,32}$")] = None,  # cache key only
) -> Response:
    filename = TILESETS.get(tileset)
    if filename is None:
        raise ApiError(404, "unknown_tileset", "Неизвестный набор тайлов")
    if not (0 <= z <= MAX_TILE_ZOOM) or not (0 <= x < 2**z) or not (0 <= y < 2**z):
        raise ApiError(404, "tile_out_of_range", "Тайл вне диапазона")
    archive = _archives.get(basemap_dir(request) / filename)
    if archive is None:
        raise ApiError(503, "basemap_unavailable", "Базовая карта ещё не собрана (make basemap)")
    max_age = request.app.state.container.settings.tile_cache_max_age_seconds
    etag = f'"{archive.etag_base}-{zxy_to_tileid(z, x, y):x}"'
    headers = {"ETag": etag, "Cache-Control": f"public, max-age={max_age}, must-revalidate"}
    if etag in [t.strip().removeprefix("W/") for t in request.headers.get("if-none-match", "").split(",")]:
        return Response(status_code=304, headers=headers)
    data = archive.reader.get(z, x, y)
    if not data:
        # Outside the extract or an empty tile: MapLibre treats 204 as "no data", not an error.
        return Response(status_code=204, headers=headers)
    if archive.header["tile_compression"] == Compression.GZIP:
        data = gzip.decompress(data)
    return Response(content=data, media_type="application/x-protobuf", headers=headers)


def satellite_config(settings) -> dict:
    """The satellite underlay is offered only in non-commercial mode (licence CC BY-NC-SA 4.0)."""
    if settings.app_usage_mode != "noncommercial":
        reason = "APP_USAGE_MODE=commercial: некоммерческая лицензия EOX неприменима"
        return {"enabled": False, "reason": reason}
    if settings.map_satellite == "off":
        return {"enabled": False, "reason": "MAP_SATELLITE=off"}
    return {"enabled": True, **EOX_SATELLITE}


@router.get("/basemap", responses={503: {"model": ErrorResponse}})
def basemap_info(request: Request) -> dict:
    """Coverage, provenance, licences and building height statistics of the city-wide base map."""
    settings = request.app.state.container.settings
    path = basemap_dir(request) / "manifest.json"
    try:
        m = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as e:
        raise ApiError(503, "basemap_unavailable", "Базовая карта ещё не собрана (make basemap)") from e
    b = m.get("buildings", {})
    landmarks = b.get("landmarks", [])
    stylised = [{"osm": lm["osm"], "centroid": lm.get("centroid")} for lm in landmarks if lm.get("applied")]
    return {
        "bbox": m.get("bbox"),
        "built_at": m.get("built_at"),
        "attribution": m.get("attribution"),
        "licenses": m.get("licenses", {}),
        "coverage": m.get("coverage", {}),
        "base_source": m.get("base", {}).get("source"),
        "buildings_source": b.get("source"),
        "level_height_m": b.get("level_height_m"),
        "default_height_m": b.get("default_height_m"),
        "height_source": {
            "height": 0,
            "levels": 0,
            "estimate": 0,
            "default": 0,
            **b.get("height_source", {}),
        },
        "tiles_version": m.get("tiles_version") or None,
        "estimate_rules": b.get("estimate_rules", {}),
        "roofs": b.get("roofs", {}),
        "stylised_landmarks": stylised,
        "buildings": b.get("counts", {}).get("buildings"),
        "usage_mode": settings.app_usage_mode,
        "satellite": satellite_config(settings),
    }


@router.get(
    "/basemap/boundary",
    responses={
        200: {"content": {"application/geo+json": {}}, "description": "City administrative boundary"},
        503: {"model": ErrorResponse},
    },
)
def basemap_boundary(request: Request) -> Response:
    path = basemap_dir(request) / BOUNDARY_FILE
    if not path.is_file():
        raise ApiError(503, "basemap_unavailable", "Граница города ещё не подготовлена (make basemap)")
    max_age = request.app.state.container.settings.map_cache_max_age_seconds
    return Response(
        content=path.read_bytes(),
        media_type="application/geo+json",
        headers={"Cache-Control": f"public, max-age={max_age}, must-revalidate"},
    )


def basemap_status(data_dir: Path) -> tuple[bool, str]:
    d = data_dir / "basemap"
    missing = [f for f in (*TILESETS.values(), "manifest.json") if not (d / f).is_file()]
    if missing:
        return False, "Нет файлов базовой карты: " + ", ".join(missing) + " (make basemap)"
    return True, "Тайлы базовой карты: " + ", ".join(TILESETS)
