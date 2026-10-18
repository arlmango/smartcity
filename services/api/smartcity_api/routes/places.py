"""/api/places, /api/places/{id}, /api/search, /api/recommend."""

from __future__ import annotations

import asyncio
import math
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response

from smartcity_api.contracts import (
    Category,
    ErrorResponse,
    PlaceDetail,
    PlacesResponse,
    RecommendRequest,
    RecommendResponse,
    SearchResponse,
)
from smartcity_api.domain.categories import CATEGORY_INFO
from smartcity_api.domain.parser import _SOFT_CATEGORY_RE, normalize
from smartcity_api.errors import ApiError, ClientDisconnected
from smartcity_api.retrieval import repository as repo
from smartcity_api.routes.system import container_of
from smartcity_api.services import recommend as rec
from smartcity_api.services.enrich import place_detail, place_summary

router = APIRouter(prefix="/api")

MAX_BBOX_SPAN_DEG = 1.0
ERRORS: dict[int | str, dict[str, Any]] = {422: {"model": ErrorResponse}, 429: {"model": ErrorResponse}}


def parse_bbox(raw: str) -> tuple[float, float, float, float]:
    parts = raw.split(",")
    if len(parts) != 4:
        raise ApiError(422, "invalid_bbox", "bbox: ожидается minlon,minlat,maxlon,maxlat")
    try:
        vals = [float(p) for p in parts]
    except ValueError as e:
        raise ApiError(422, "invalid_bbox", "bbox: значения должны быть числами") from e
    if not all(math.isfinite(v) for v in vals):
        raise ApiError(422, "invalid_bbox", "bbox: значения должны быть конечными числами")
    minlon, minlat, maxlon, maxlat = vals
    if not (-180 <= minlon <= 180 and -180 <= maxlon <= 180 and -90 <= minlat <= 90 and -90 <= maxlat <= 90):
        raise ApiError(422, "invalid_bbox", "bbox: координаты вне допустимого диапазона")
    if minlon >= maxlon or minlat >= maxlat:
        raise ApiError(422, "invalid_bbox", "bbox: min должен быть меньше max")
    if maxlon - minlon > MAX_BBOX_SPAN_DEG or maxlat - minlat > MAX_BBOX_SPAN_DEG:
        raise ApiError(422, "bbox_too_large", f"bbox: не больше {MAX_BBOX_SPAN_DEG}° по каждой оси")
    return minlon, minlat, maxlon, maxlat


@router.get("/places", response_model=PlacesResponse, responses=ERRORS)
def places(
    request: Request,
    bbox: Annotated[str, Query(max_length=120, description="minlon,minlat,maxlon,maxlat (WGS84)")],
    category: Category | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> PlacesResponse:
    c = container_of(request)
    box = parse_bbox(bbox)
    with c.sessionmaker() as s:
        rows, truncated = repo.places_in_bbox(s, bbox=box, category=category, limit=limit)
        cov = repo.load_coverage(s)
    return PlacesResponse(
        dataset_version=cov[0].dataset_version if cov else "none",
        items=[place_summary(r) for r in rows],
        truncated=truncated,
    )


@router.get(
    "/places/{place_id}", response_model=PlaceDetail, responses={404: {"model": ErrorResponse}, **ERRORS}
)
def place(place_id: str, request: Request) -> PlaceDetail:
    try:
        pid = uuid.UUID(place_id)
    except ValueError as e:
        raise ApiError(422, "invalid_place_id", "Некорректный идентификатор места") from e
    c = container_of(request)
    with c.sessionmaker() as s:
        row = repo.get_place(s, pid)
    if row is None:
        raise ApiError(404, "place_not_found", "Место не найдено")
    return place_detail(row)


@router.get("/search", response_model=SearchResponse, responses=ERRORS)
def search(
    request: Request,
    q: Annotated[str, Query(min_length=1, max_length=100)],
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> SearchResponse:
    query = q.strip()
    if not query:
        raise ApiError(422, "invalid_query", "Пустой поисковый запрос")
    norm = normalize(query)
    cats = []
    if len(norm) >= 3:
        for cat, info in CATEGORY_INFO.items():
            if info.label.lower().replace("ё", "е").startswith(norm) or _SOFT_CATEGORY_RE[cat].search(norm):
                cats.append(cat)
    c = container_of(request)
    with c.sessionmaker() as s:
        rows = repo.search_places(s, q=query, categories=cats, limit=limit)
    return SearchResponse(
        query=query, items=[place_summary(r) for r in rows], method="lexical(name,names,address,category)"
    )


@router.post(
    "/recommend",
    response_model=RecommendResponse,
    responses={**ERRORS, 413: {"model": ErrorResponse}, 504: {"model": ErrorResponse}},
)
async def recommend(body: RecommendRequest, request: Request) -> RecommendResponse | Response:
    c = container_of(request)
    request_id = getattr(request.state, "request_id", None)
    try:
        return await asyncio.wait_for(
            rec.recommend(c, body, request.is_disconnected, request_id=request_id),
            timeout=c.settings.request_timeout_seconds + 10,
        )
    except ClientDisconnected:
        return Response(status_code=499)
    except TimeoutError as e:
        raise ApiError(504, "timeout", "Превышено время обработки запроса. Повторите позже.") from e
