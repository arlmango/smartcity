"""FastAPI application: `smartcity_api.main:app`."""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from smartcity_api.config import Settings, get_settings
from smartcity_api.contracts import ErrorResponse
from smartcity_api.errors import ApiError
from smartcity_api.middleware import SmartCityMiddleware
from smartcity_api.observability import configure_logging
from smartcity_api.routes import places, system, tiles
from smartcity_api.runtime import Container, build_container

log = logging.getLogger("smartcity.api")

_HTTP_CODES = {
    400: ("bad_request", "Некорректный запрос"),
    404: ("not_found", "Ресурс не найден"),
    405: ("method_not_allowed", "Метод не поддерживается"),
    413: ("payload_too_large", "Слишком большой запрос"),
}


def _rid(request: Request) -> str | None:
    return getattr(request.state, "request_id", None)


def _err(
    request: Request, status: int, error: str, message: str, headers: dict | None = None
) -> JSONResponse:
    body = ErrorResponse(error=error, message=message, request_id=_rid(request))
    return JSONResponse(body.model_dump(), status_code=status, headers=headers)


def create_app(settings: Settings | None = None, container: Container | None = None) -> FastAPI:
    settings = settings or (container.settings if container else get_settings())
    configure_logging(settings.log_level)
    app = FastAPI(
        title="SmartCity API",
        version="1.0.0",
        description="Grounded walk recommendations for Astana (EXPO / MEGA Silk Way area). API v1.",
        # Interactive docs are off unless explicitly enabled (the OpenAPI snapshot lives in
        # packages/contracts/openapi.json).
        docs_url="/docs" if os.environ.get("API_DOCS") == "1" else None,
        redoc_url=None,
        openapi_url="/openapi.json" if os.environ.get("API_DOCS") == "1" else None,
    )
    app.state.container = container or build_container(settings)

    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
        return _err(request, exc.status, exc.error, exc.message, exc.headers or None)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        # Field locations only; the submitted values are never echoed back.
        locs = []
        for e in exc.errors()[:10]:
            loc = ".".join(str(x) for x in e.get("loc", ()) if x not in ("body", "query", "path"))
            if loc and loc not in locs:
                locs.append(loc)
        msg = "Некорректные данные запроса" + (": " + ", ".join(locs) if locs else "")
        return _err(request, 422, "validation_error", msg)

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code, msg = _HTTP_CODES.get(exc.status_code, ("http_error", "Ошибка запроса"))
        return _err(request, exc.status_code, code, msg)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.error(
            "unhandled error",
            extra={"event": "error", "request_id": _rid(request), "error": type(exc).__name__},
        )
        return _err(request, 500, "internal_error", "Внутренняя ошибка сервера")

    app.include_router(system.router)
    app.include_router(places.router)
    app.include_router(tiles.router)

    origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "If-None-Match"],
        expose_headers=["ETag", "X-Request-ID", "Retry-After"],
        allow_credentials=False,
    )
    app.add_middleware(
        SmartCityMiddleware,
        max_body_bytes=settings.max_body_bytes,
        recommend_limit=settings.rate_limit,
        general_limit=settings.rate_limit_general,
        tiles_limit=settings.rate_limit_tiles,
        trust_forwarded_for=settings.trust_forwarded_for,
    )
    return app


app: FastAPI  # created lazily on first access (uvicorn "smartcity_api.main:app")


def __getattr__(name: str):  # lazy `app` so importing the module (tests, OpenAPI export) builds nothing
    if name == "app":
        global app
        app = create_app()
        return app
    raise AttributeError(name)
