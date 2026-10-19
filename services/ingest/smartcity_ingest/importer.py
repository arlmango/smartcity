"""Transactional import of a snapshot into the shared schema (smartcity_api.db.models).

- One ingest_runs row per import: committed as `running` first, finalized as complete/partial/failed.
- All place changes happen in a single transaction; any error rolls everything back.
- Natural key (source='osm', source_type, source_id). Unchanged content_hash -> row not touched.
- Tombstones (active=false) only when the snapshot is complete (every query group succeeded).
"""

from __future__ import annotations

import logging
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime

from geoalchemy2.shape import from_shape
from shapely.geometry.base import BaseGeometry
from smartcity_api.db.models import Coverage, IngestRun, Place, PlaceEvidence
from sqlalchemy import Engine, func, select, update
from sqlalchemy.orm import Session

from smartcity_ingest.geometry import element_geometry, polygonal, round_coords
from smartcity_ingest.normalize import LICENSE, PlaceRecord, build_context, normalize_places
from smartcity_ingest.overpass import POI_GROUPS
from smartcity_ingest.paths import CoverageArea
from smartcity_ingest.snapshot import Snapshot

log = logging.getLogger("smartcity_ingest.importer")
SOURCE = "osm"


@dataclass
class ImportResult:
    run_id: uuid.UUID
    status: str
    counts: dict = field(default_factory=dict)
    error: str | None = None


def _building_geoms(snapshot: Snapshot) -> list[BaseGeometry] | None:
    if not snapshot.group_ok("map_buildings"):
        return None
    out = []
    for el in snapshot.elements("map_buildings"):
        g = element_geometry(el)
        if g is not None and g.geom_type in ("Polygon", "MultiPolygon"):
            out.append(g)
    return out


def _apply_record(row: Place, rec: PlaceRecord, fetched_at: datetime, run_id: uuid.UUID) -> None:
    row.name = rec.name
    row.name_is_generic = rec.name_is_generic
    row.names = rec.names
    row.aliases = rec.aliases
    row.geom = from_shape(round_coords(rec.geom, 7), srid=4326)
    row.location = from_shape(rec.location, srid=4326)
    row.bbox = rec.bbox
    row.category = rec.category
    row.subcategory = rec.subcategory
    row.tags = rec.tags
    row.description = rec.description
    row.address = rec.address
    row.opening_hours_raw = rec.opening_hours_raw
    row.timezone = "Asia/Almaty"
    row.website = rec.website
    row.active = True
    row.content_hash = rec.content_hash
    row.fetched_at = fetched_at
    row.source_updated_at = rec.source_updated_at
    row.source_version = rec.source_version
    row.last_seen_run_id = run_id


def _write_evidence(session: Session, row: Place, rec: PlaceRecord, collected_at: datetime) -> None:
    ev_rows = [
        PlaceEvidence(
            place_id=row.id,
            field=e.field,
            source_url=e.source_url,
            source_license=LICENSE,
            collected_at=collected_at,
            source_value=e.source_value,
        )
        for e in rec.evidence
    ]
    session.add_all(ev_rows)
    session.flush()
    amen = {}
    for feat, val in rec.amenities.items():
        d = dict(val)
        d["evidence_ids"] = [r.id for r in ev_rows if r.field == feat]
        amen[feat] = d
    row.amenities = amen


def run_import(engine: Engine, snapshot: Snapshot, coverage: CoverageArea) -> ImportResult:
    run_id = uuid.uuid4()
    started = datetime.now(UTC)
    with Session(engine) as s, s.begin():
        s.add(
            IngestRun(
                run_id=run_id,
                source=f"{snapshot.manifest.get('source')} {snapshot.manifest.get('endpoint')}",
                coverage_id=coverage.id,
                polygon=coverage.geojson,
                started_at=started,
                status="running",
                counts={},
                snapshot_hash=snapshot.snapshot_hash,
                dataset_version=snapshot.dataset_version,
            )
        )

    poi_ok = [g for g in POI_GROUPS if snapshot.group_ok(g)]
    poi_failed = [g for g in POI_GROUPS if g in snapshot.manifest["groups"] and not snapshot.group_ok(g)]
    counts: dict = {
        "groups_ok": [g for g in snapshot.manifest["groups"] if snapshot.group_ok(g)],
        "groups_failed": [g for g in snapshot.manifest["groups"] if not snapshot.group_ok(g)],
        "snapshot_complete": snapshot.complete,
    }
    status = "failed"
    error: str | None = None
    try:
        if not poi_ok:
            raise RuntimeError("no POI query group succeeded; nothing imported")
        elements: list[dict] = []
        for g in poi_ok:
            elements.extend(snapshot.elements(g))
        ctx = build_context(snapshot.elements("poi_mall"), _building_geoms(snapshot))
        stats: dict = {}
        records = normalize_places(elements, coverage.geometry, ctx, stats)
        fetched_at = snapshot.fetched_at.astimezone(UTC)

        with Session(engine) as s, s.begin():
            existing = {
                (p.source_type, p.source_id): p
                for p in s.scalars(select(Place).where(Place.source == SOURCE))
            }
            c = Counter()
            seen: set[tuple[str, int]] = set()
            for rec in records:
                seen.add(rec.key)
                row = existing.get(rec.key)
                if row is None:
                    row = Place(
                        id=uuid.uuid4(), source=SOURCE, source_type=rec.source_type, source_id=rec.source_id
                    )
                    _apply_record(row, rec, fetched_at, run_id)
                    row.amenities = {}
                    s.add(row)
                    s.flush()
                    _write_evidence(s, row, rec, fetched_at)
                    c["inserted"] += 1
                elif row.content_hash == rec.content_hash:
                    if row.active:
                        c["unchanged"] += 1
                    else:
                        row.active = True
                        row.last_seen_run_id = run_id
                        c["reactivated"] += 1
                else:
                    _apply_record(row, rec, fetched_at, run_id)
                    row.evidence.clear()  # delete-orphan cascade removes previous evidence rows
                    s.flush()
                    _write_evidence(s, row, rec, fetched_at)
                    c["updated"] += 1
            # Merge (not tombstone): an object that is present in THIS snapshot but was merged into a
            # polygon record as an alias is deactivated in the same transaction, even for a partial
            # snapshot — the evidence for the merge (both objects) is in the snapshot itself.
            alias_keys = {(a["source_type"], int(a["source_id"])) for r in records for a in r.aliases}
            merged_rows = [k for k in alias_keys if k in existing and k not in seen and existing[k].active]
            for k in merged_rows:
                existing[k].active = False
            c["merged_into_alias"] = len(merged_rows)
            seen |= alias_keys
            if snapshot.complete:
                gone = [k for k, p in existing.items() if k not in seen and p.active]
                for k in gone:
                    existing[k].active = False
                c["deactivated"] = len(gone)
            else:
                c["deactivated"] = 0
                c["deactivation_skipped_reason"] = "snapshot not complete"  # type: ignore[assignment]
            s.flush()

            active_count = s.scalar(
                select(func.count()).select_from(Place).where(Place.source == SOURCE, Place.active.is_(True))
            )
            cov = s.get(Coverage, coverage.id)
            freshness = snapshot.osm_base or fetched_at
            cov_geom = from_shape(polygonal(coverage.geometry) or coverage.geometry, srid=4326)
            if cov is None:
                s.add(
                    Coverage(
                        id=coverage.id,
                        name=coverage.name,
                        geom=cov_geom,
                        dataset_version=snapshot.dataset_version,
                        freshness=freshness,
                        place_count=active_count or 0,
                    )
                )
            elif snapshot.complete:
                cov.name = coverage.name
                cov.geom = cov_geom
                cov.dataset_version = snapshot.dataset_version
                cov.freshness = freshness
                cov.place_count = active_count or 0
            else:
                cov.place_count = active_count or 0

            counts.update(dict(c))
            counts["records"] = len(records)
            counts["active_places"] = active_count
            counts["by_category"] = dict(sorted(Counter(r.category for r in records).items()))
            counts["skipped_unnamed"] = stats.get("skipped_unnamed", 0)
            counts["skipped_no_geometry"] = stats.get("skipped_no_geometry", 0)
            counts["skipped_outside_coverage"] = stats.get("skipped_outside_coverage", 0)
            counts["website_rejected"] = stats.get("website_rejected", 0)
            counts["dedup_merges"] = len(stats.get("dedup_merges", []))
            counts["dedup_merge_list"] = stats.get("dedup_merges", [])
            counts["dedup_rejected"] = stats.get("dedup_rejected", [])
            counts["poi_groups_failed"] = poi_failed
        status = "complete" if snapshot.complete else "partial"
    except Exception as e:  # noqa: BLE001 - recorded in ingest_runs and re-reported
        error = f"{type(e).__name__}: {e}"[:1000]
        log.error("import failed: %s", error)
        status = "failed"

    with Session(engine) as s, s.begin():
        s.execute(
            update(IngestRun)
            .where(IngestRun.run_id == run_id)
            .values(status=status, counts=counts, finished_at=datetime.now(UTC), error_summary=error)
        )
    return ImportResult(run_id=run_id, status=status, counts=counts, error=error)
