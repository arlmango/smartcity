"""Server-side fact enrichment: everything factual on a card comes from the DB row."""

from __future__ import annotations

from urllib.parse import urlsplit

from smartcity_api.contracts import EvidenceItem, FeatureFact, LatLon, PlaceDetail, PlaceSummary, SourceRef
from smartcity_api.domain.categories import category_label
from smartcity_api.domain.features import FeatureSummary, summarize_features
from smartcity_api.retrieval.repository import PlaceRow

OSM_BASE = "https://www.openstreetmap.org"
GENERIC_NAME_LABEL = "без названия в OSM"


def osm_url(source_type: str, source_id: int) -> str:
    if source_type not in ("node", "way", "relation"):
        raise ValueError("bad osm type")
    return f"{OSM_BASE}/{source_type}/{int(source_id)}"


def safe_website(url: str | None) -> str | None:
    """Only absolute http(s) URLs without credentials/whitespace; anything else is dropped."""
    if not url or not isinstance(url, str):
        return None
    url = url.strip()
    if len(url) > 300 or any(c.isspace() for c in url) or any(c in url for c in "<>\"'`"):
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        return None
    if parts.username or parts.password:
        return None
    return url


def format_address(addr: dict | None) -> str | None:
    if not addr or not isinstance(addr, dict):
        return None

    def g(*keys: str) -> str | None:
        for k in keys:
            v = addr.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
        return None

    full = g("full", "addr:full")
    street = g("street", "addr:street")
    house = g("housenumber", "addr:housenumber")
    if street and house:
        return f"{street}, {house}"
    if street:
        return street
    if full:
        return full
    place = g("place", "addr:place")
    if place and house:
        return f"{place}, {house}"
    return None


def features_for(place: PlaceRow) -> FeatureSummary:
    ev = {e.id: e.source_value for e in place.evidence}
    return summarize_features(place.amenities, place.category, ev)


def feature_facts(summary: FeatureSummary) -> tuple[list[FeatureFact], list[FeatureFact], list[str]]:
    verified = [
        FeatureFact(feature=f.feature, value=True, basis=f.basis, evidence=f.evidence)  # type: ignore[arg-type]
        for f in summary.verified
    ]
    negative = [
        FeatureFact(feature=f.feature, value=False, basis=f.basis, evidence=f.evidence)  # type: ignore[arg-type]
        for f in summary.negative
    ]
    return verified, negative, list(summary.unknown)


def source_ref(place: PlaceRow) -> SourceRef:
    return SourceRef(
        osm_type=place.source_type,  # type: ignore[arg-type]
        osm_id=place.source_id,
        url=osm_url(place.source_type, place.source_id),
        fetched_at=place.fetched_at,
        source_updated_at=place.source_updated_at,
    )


def evidence_items(place: PlaceRow) -> list[EvidenceItem]:
    fallback = osm_url(place.source_type, place.source_id)
    out = []
    for e in place.evidence[:30]:
        url = e.source_url if e.source_url.startswith(OSM_BASE + "/") else fallback
        out.append(
            EvidenceItem(
                field=e.field,
                source_value=e.source_value[:300],
                source_url=url,
                license=e.source_license,
                collected_at=e.collected_at,
            )
        )
    return out


def place_summary(place: PlaceRow) -> PlaceSummary:
    return PlaceSummary(
        place_id=place.pid,
        name=place.name,
        name_is_generic=place.name_is_generic,
        category=place.category,  # type: ignore[arg-type]
        category_label=category_label(place.category),
        coordinates=LatLon(lat=place.lat, lon=place.lon),
        address=format_address(place.address),
    )


def place_detail(place: PlaceRow) -> PlaceDetail:
    verified, negative, unknown = feature_facts(features_for(place))
    s = place_summary(place)
    return PlaceDetail(
        **s.model_dump(),
        description=place.description,
        opening_hours_raw=place.opening_hours_raw,
        website=safe_website(place.website),
        verified_features=verified,
        unknown_features=unknown,  # type: ignore[arg-type]
        negative_features=negative,
        source=source_ref(place),
        evidence=evidence_items(place),
    )
