"""Shared database schema (single owner: coordinator).

Backend (services/api) and ingest (services/ingest) both use these models; neither
creates competing tables. Schema changes go through Alembic migrations in
services/api/alembic.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from geoalchemy2 import Geography, Geometry
from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

# Normalized categories used across ingest, retrieval and UI.
CATEGORIES = ("cafe", "food", "park", "culture", "attraction", "playground", "mall")

# Amenity / feature properties tracked per place. Value is true|false|null(unknown).
FEATURES = ("socket", "wifi", "outdoor_seating", "wheelchair", "indoor", "kids")


class Base(DeclarativeBase):
    pass


class Place(Base):
    __tablename__ = "places"
    __table_args__ = (UniqueConstraint("source", "source_type", "source_id", name="uq_places_natural_key"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source: Mapped[str] = mapped_column(String(32), nullable=False)  # "osm"
    source_type: Mapped[str] = mapped_column(String(16), nullable=False)  # node|way|relation
    source_id: Mapped[int] = mapped_column(BigInteger, nullable=False)

    name: Mapped[str] = mapped_column(Text, nullable=False)
    # True when OSM has no name and the server shows a generic label (e.g. playgrounds).
    name_is_generic: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    names: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)  # {"ru": ..., "kk": ..., "en": ...}
    aliases: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)  # merged duplicates [{source_type, source_id}]

    geom = mapped_column(Geometry("GEOMETRY", srid=4326), nullable=True)
    location = mapped_column(Geography("POINT", srid=4326), nullable=False)
    bbox: Mapped[list | None] = mapped_column(JSONB, nullable=True)  # [minlon,minlat,maxlon,maxlat]

    category: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    subcategory: Mapped[str] = mapped_column(String(64), nullable=False)  # raw OSM value, e.g. "fast_food"
    tags: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")  # built from factual fields only
    address: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    opening_hours_raw: Mapped[str | None] = mapped_column(Text, nullable=True)
    timezone: Mapped[str] = mapped_column(String(64), nullable=False, default="Asia/Almaty")
    website: Mapped[str | None] = mapped_column(Text, nullable=True)
    # feature -> {"value": true|false|null, "evidence_ids": [int], "basis": "tag"|"category_rule"|null}
    amenities: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)

    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    source_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    source_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_seen_run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    evidence: Mapped[list[PlaceEvidence]] = relationship(back_populates="place", cascade="all, delete-orphan")


class PlaceEvidence(Base):
    __tablename__ = "place_evidence"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    place_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("places.id", ondelete="CASCADE"), index=True
    )
    field: Mapped[str] = mapped_column(String(64), nullable=False)  # e.g. "name", "opening_hours", "socket"
    source_url: Mapped[str] = mapped_column(Text, nullable=False)  # https://www.openstreetmap.org/{type}/{id}
    source_license: Mapped[str] = mapped_column(String(64), nullable=False, default="ODbL-1.0")
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    source_value: Mapped[str] = mapped_column(Text, nullable=False)  # short tag excerpt, e.g. "power_supply=yes"

    place: Mapped[Place] = relationship(back_populates="evidence")


class PlaceEmbedding(Base):
    __tablename__ = "place_embeddings"
    __table_args__ = (UniqueConstraint("place_id", "model_id", name="uq_place_embedding_model"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    place_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("places.id", ondelete="CASCADE"), index=True
    )
    # Dimension is not fixed in the column: model_id + dim identify a consistent index.
    # Queries always filter by the active model_id and dim (no mixing of vector spaces).
    embedding = mapped_column(Vector(), nullable=False)
    model_id: Mapped[str] = mapped_column(String(200), nullable=False, index=True)  # provider:model@digest
    dim: Mapped[int] = mapped_column(Integer, nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    embedded_text_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class IngestRun(Base):
    __tablename__ = "ingest_runs"

    run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    coverage_id: Mapped[str] = mapped_column(String(128), nullable=False)
    polygon: Mapped[dict] = mapped_column(JSONB, nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False)  # running|complete|partial|failed
    counts: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    error_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    snapshot_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    dataset_version: Mapped[str | None] = mapped_column(String(64), nullable=True)


class Coverage(Base):
    __tablename__ = "coverage"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    geom = mapped_column(Geometry("GEOMETRY", srid=4326), nullable=False)
    dataset_version: Mapped[str] = mapped_column(String(64), nullable=False)
    freshness: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)  # OSM base timestamp
    place_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
