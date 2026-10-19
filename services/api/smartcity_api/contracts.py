"""SmartCity API v1 contracts (single source of truth, owner: coordinator).

The OpenAPI snapshot in packages/contracts/openapi.json is generated from these models
(`make contracts`) and the web client types are generated from that snapshot.
Changing a model here is a contract change: regenerate and update both sides.

Rules encoded here:
- Facts (name, coordinates, hours, website, evidence) are always server-filled from the DB.
- Estimates are marked (`timing.estimated`, `activity_suggestion`), never presented as facts.
- Fields that were not computed are null/absent, not 0 placeholders.
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

Category = Literal["cafe", "food", "park", "culture", "attraction", "playground", "mall"]
Feature = Literal["socket", "wifi", "outdoor_seating", "wheelchair", "indoor", "kids"]
Interest = Literal[
    "coffee", "food", "nature", "culture", "architecture", "kids", "quiet", "indoor", "shopping"
]
OpeningStatus = Literal["open", "closed", "unknown"]
DistanceMethod = Literal["pedestrian_route", "geodesic"]
ResponseStatus = Literal["ok", "no_match", "needs_clarification", "degraded"]
ResponseMode = Literal["live_rag", "retrieval_only"]
ConstraintSource = Literal["ui", "text"]

DroppedCode = Annotated[
    str,
    StringConstraints(
        pattern=r"^(must_be_open|max_distance|(include_category|exclude_category):(cafe|food|park|culture|"
        r"attraction|playground|mall)|required_feature:(socket|wifi|outdoor_seating|wheelchair|indoor|kids))$"
    ),
]
ClientRequestId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{8,64}$")]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LatLon(StrictModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)

    @field_validator("lat", "lon")
    @classmethod
    def _finite(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("coordinate must be finite")
        return v


# ---------------------------------------------------------------- recommend: request


class Constraints(StrictModel):
    """Explicit user controls. These are the source of truth and override LLM guesses."""

    required_features: list[Feature] = Field(default_factory=list, max_length=6)
    preferred_features: list[Feature] = Field(default_factory=list, max_length=6)
    include_categories: list[Category] = Field(default_factory=list, max_length=7)  # "только ..."
    exclude_categories: list[Category] = Field(default_factory=list, max_length=7)  # "без кафе"
    must_be_open: bool = False  # open on arrival and for the whole visit (unknown hours excluded)
    max_distance_m: int | None = Field(default=None, ge=100, le=10000)  # "поближе"
    exclude_place_ids: list[str] = Field(default_factory=list, max_length=20)  # "другие варианты"
    # Text-derived hard conditions the user explicitly dropped (via a relaxation), so the text parser
    # does not re-add them on resend. Codes: "must_be_open", "max_distance",
    # "include_category:<category>", "exclude_category:<category>", "required_feature:<feature>".
    dropped_text_constraints: list[DroppedCode] = Field(default_factory=list, max_length=20)


class ConversationTurn(StrictModel):
    role: Literal["user", "assistant"]
    text: str = Field(max_length=500)


class RecommendRequest(StrictModel):
    origin: LatLon
    query: str = Field(default="", max_length=2000)
    time_budget_min: int = Field(ge=10, le=180)
    return_to_start: bool = True
    travel_mode: Literal["walking"] = "walking"
    interests: list[Interest] = Field(default_factory=list, max_length=9)
    constraints: Constraints = Field(default_factory=Constraints)
    conversation_context: list[ConversationTurn] = Field(default_factory=list, max_length=6)
    # Planned start time (timezone-aware). Allowed window: now-10min .. now+7days. Default: now.
    start_time: datetime | None = None
    client_request_id: ClientRequestId

    @field_validator("start_time")
    @classmethod
    def _aware(cls, v: datetime | None) -> datetime | None:
        if v is not None and (v.tzinfo is None or v.utcoffset() is None):
            raise ValueError("start_time must include a timezone offset")
        return v

    # include/exclude overlap is not a validation error: the service answers needs_clarification.


# ---------------------------------------------------------------- recommend: response


class AppliedConstraint(StrictModel):
    kind: Literal[
        "time_budget",
        "return_to_start",
        "walking_only",
        "required_feature",
        "include_category",
        "exclude_category",
        "must_be_open",
        "max_distance",
    ]
    value: str | int | bool
    source: ConstraintSource
    label: str  # Russian, user-facing


class ConstraintsApplied(StrictModel):
    hard: list[AppliedConstraint]
    preferences: list[str]  # Russian labels of soft wishes used only for ranking
    interpreted_query: str | None = None  # short Russian paraphrase (LLM or rules); never a fact


class Distance(StrictModel):
    meters: int
    method: DistanceMethod
    note: str  # e.g. "По прямой; реальный путь длиннее"


class Timing(StrictModel):
    outbound_min: int
    visit_min: int
    return_min: int | None  # null when return_to_start is false
    buffer_min: int
    total_min: int
    estimated: Literal[True] = True
    method: str  # human readable formula / basis


class FeatureFact(StrictModel):
    feature: Feature
    value: bool
    basis: Literal["tag", "category_rule"]
    evidence: str  # e.g. "OSM: internet_access=wlan" or "Правило категории: музей — в помещении"


class EvidenceItem(StrictModel):
    field: str
    source_value: str
    source_url: str
    license: str
    collected_at: datetime


class SourceRef(StrictModel):
    name: Literal["OpenStreetMap"] = "OpenStreetMap"
    osm_type: Literal["node", "way", "relation"]
    osm_id: int
    url: str  # https://www.openstreetmap.org/{type}/{id} — built by the server
    license: str = "ODbL-1.0"
    fetched_at: datetime
    source_updated_at: datetime | None = None


class RouteGeometry(StrictModel):
    type: Literal["LineString"] = "LineString"
    coordinates: list[tuple[float, float]] = Field(min_length=2, max_length=20000)

    @field_validator("coordinates")
    @classmethod
    def valid_coordinates(cls, value):
        if any(
            not math.isfinite(x) or not math.isfinite(y) or not -180 <= x <= 180 or not -90 <= y <= 90
            for x, y in value
        ):
            raise ValueError("invalid route coordinates")
        return value


class RouteLeg(StrictModel):
    geometry: RouteGeometry
    distance_m: int = Field(ge=0)
    duration_s: int = Field(ge=0)
    start_snap_m: int = Field(ge=0, le=100)
    end_snap_m: int = Field(ge=0, le=100)
    access_estimate_min: int = Field(ge=0)


class WalkingRoute(StrictModel):
    provider: Literal["valhalla"] = "valhalla"
    graph_version: str
    outbound: RouteLeg
    return_leg: RouteLeg | None
    note: str


class RouteRequest(StrictModel):
    origin: LatLon
    destination: LatLon
    return_to_start: bool = True


class PlanStop(StrictModel):
    place_id: str
    name: str  # from DB
    name_is_generic: bool
    category: Category
    category_label: str
    coordinates: LatLon  # from DB
    leg_in: RouteLeg  # router leg arriving at this stop
    arrive_min: int = Field(ge=0)  # minutes after the start (estimate)
    visit_min: int = Field(ge=0)  # typical visit for the category (estimate, not a fact)
    opening_status: OpeningStatus


class PlanSkip(StrictModel):
    place_id: str
    name: str
    reason: str  # Russian, user-facing


class WalkPlan(StrictModel):
    """Deterministic 2–3 stop plan; every distance/time comes from the router, never from the LLM."""

    stops: list[PlanStop] = Field(min_length=2, max_length=3)
    return_leg: RouteLeg | None  # last stop -> start, when return_to_start
    graph_version: str
    time_budget_min: int
    walk_min: int = Field(ge=0)
    visit_min: int = Field(ge=0)
    buffer_min: int = Field(ge=0)
    total_min: int = Field(ge=0)
    distance_m: int = Field(ge=0)
    returns_to_start: bool
    why: list[str]  # code-generated explanation of the trade-off
    skipped: list[PlanSkip]
    method: str


class Recommendation(StrictModel):
    route: WalkingRoute | None = None
    place_id: str
    name: str  # from DB
    name_is_generic: bool
    category: Category
    category_label: str
    coordinates: LatLon  # from DB, never from the model
    address: str | None
    reason: str | None  # LLM text grounded in candidate fields; null in retrieval_only mode
    reason_source: Literal["llm", "rules"]
    activity_suggestion: str | None  # an idea/estimate, not a fact
    distance: Distance
    timing: Timing
    opening_status: OpeningStatus
    opening_hours_raw: str | None
    opening_note: str  # Russian explanation, e.g. "Часы не указаны"
    as_of: datetime  # dataset snapshot time for these facts
    verified_features: list[FeatureFact]
    unknown_features: list[Feature]
    negative_features: list[FeatureFact]
    website: str | None  # only http(s) URLs from OSM tags, validated server-side
    source: SourceRef
    evidence: list[EvidenceItem]


class Warning(StrictModel):  # noqa: A001 - domain name
    code: str
    message: str


class Relaxation(StrictModel):
    code: str
    message: str  # Russian, e.g. "Показать кафе, где наличие розеток не подтверждено"
    patch: Constraints  # full constraints object to resend


class ProviderInfo(StrictModel):
    llm_provider: str | None
    llm_model: str | None
    embedding_provider: str | None
    embedding_model: str | None
    embedding_dim: int | None
    routing: Literal["none", "valhalla"]


class RecommendResponse(StrictModel):
    request_id: str
    client_request_id: str
    status: ResponseStatus
    mode: ResponseMode
    dataset_version: str
    constraints_applied: ConstraintsApplied
    recommendations: list[Recommendation] = Field(max_length=3)
    message: str  # Russian summary / no-match explanation / clarification question
    warnings: list[Warning]
    suggested_relaxations: list[Relaxation]
    route: None = None  # only a real router may fill this; routing is not configured in v1
    plan: WalkPlan | None = None
    plan_note: str | None = None  # why no multi-stop plan is offered (Russian, user-facing)
    providers: ProviderInfo
    timings_ms: dict[str, int]


# ---------------------------------------------------------------- other endpoints


class ComponentStatus(StrictModel):
    status: Literal["ok", "degraded", "unavailable", "not_configured"]
    detail: str


class ReadyResponse(StrictModel):
    ready: bool  # db+data+map ok (AI may be degraded: recommendations fall back to retrieval_only)
    components: dict[str, ComponentStatus]  # db,data,map,embeddings,llm,routing


class PlaceSummary(StrictModel):
    place_id: str
    name: str
    name_is_generic: bool
    category: Category
    category_label: str
    coordinates: LatLon
    address: str | None


class PlaceDetail(PlaceSummary):
    description: str
    opening_hours_raw: str | None
    website: str | None
    verified_features: list[FeatureFact]
    unknown_features: list[Feature]
    negative_features: list[FeatureFact]
    source: SourceRef
    evidence: list[EvidenceItem]


class PlacesResponse(StrictModel):
    dataset_version: str
    items: list[PlaceSummary]
    truncated: bool


class SearchResponse(StrictModel):
    query: str
    items: list[PlaceSummary]
    method: str  # e.g. "lexical(name,address,category)"


class CoverageResponse(StrictModel):
    type: Literal["FeatureCollection"] = "FeatureCollection"
    features: list[dict]
    dataset_version: str
    place_count: int
    freshness: datetime | None  # OSM base timestamp of the snapshot
    updated_at: datetime | None
    bbox: list[float]
    default_origin: LatLon  # clearly labelled demo start point (EXPO), not user location
    default_origin_label: str


class ErrorResponse(StrictModel):
    error: str
    message: str
    request_id: str | None = None


class RecommendStreamEvent(StrictModel):
    """One NDJSON line of POST /api/recommend/stream.

    "preliminary": places found by retrieval (mode=retrieval_only, warning "ai_pending") sent before
    generation finishes; "final": the same answer as POST /api/recommend; "error": request failed.
    """

    event: Literal["preliminary", "final", "error"]
    response: RecommendResponse | None = None
    error: ErrorResponse | None = None
