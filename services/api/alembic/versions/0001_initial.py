"""initial schema: places, evidence, embeddings, ingest runs, coverage

Revision ID: 0001_initial
Revises:
Create Date: 2026-10-18
"""

import geoalchemy2
import pgvector.sqlalchemy
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.create_table(
        "places",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("source_type", sa.String(16), nullable=False),
        sa.Column("source_id", sa.BigInteger, nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("name_is_generic", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("names", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("aliases", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column(
            "geom",
            geoalchemy2.Geometry("GEOMETRY", srid=4326, spatial_index=False),
            nullable=True,
        ),
        sa.Column(
            "location",
            geoalchemy2.Geography("POINT", srid=4326, spatial_index=False),
            nullable=False,
        ),
        sa.Column("bbox", postgresql.JSONB, nullable=True),
        sa.Column("category", sa.String(32), nullable=False),
        sa.Column("subcategory", sa.String(64), nullable=False),
        sa.Column("tags", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("address", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("opening_hours_raw", sa.Text, nullable=True),
        sa.Column("timezone", sa.String(64), nullable=False, server_default="Asia/Almaty"),
        sa.Column("website", sa.Text, nullable=True),
        sa.Column("amenities", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("active", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source_version", sa.Integer, nullable=True),
        sa.Column("last_seen_run_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("source", "source_type", "source_id", name="uq_places_natural_key"),
        sa.CheckConstraint("source_type IN ('node','way','relation')", name="ck_places_source_type"),
        sa.CheckConstraint(
            "category IN ('cafe','food','park','culture','attraction','playground','mall')",
            name="ck_places_category",
        ),
    )
    op.create_index("ix_places_category", "places", ["category"])
    op.create_index("ix_places_active", "places", ["active"])
    op.create_index("ix_places_location", "places", ["location"], postgresql_using="gist")
    op.create_index("ix_places_geom", "places", ["geom"], postgresql_using="gist")

    op.create_table(
        "place_evidence",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column(
            "place_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("places.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("field", sa.String(64), nullable=False),
        sa.Column("source_url", sa.Text, nullable=False),
        sa.Column("source_license", sa.String(64), nullable=False, server_default="ODbL-1.0"),
        sa.Column("collected_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_value", sa.Text, nullable=False),
    )
    op.create_index("ix_place_evidence_place_id", "place_evidence", ["place_id"])

    # Exact (sequential) vector scan: the dataset is ~10^2 rows, an ANN index is not justified.
    op.create_table(
        "place_embeddings",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column(
            "place_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("places.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("embedding", pgvector.sqlalchemy.Vector(), nullable=False),
        sa.Column("model_id", sa.String(200), nullable=False),
        sa.Column("dim", sa.Integer, nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("embedded_text_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("place_id", "model_id", name="uq_place_embedding_model"),
        sa.CheckConstraint("vector_dims(embedding) = dim", name="ck_place_embeddings_dim"),
    )
    op.create_index("ix_place_embeddings_place_id", "place_embeddings", ["place_id"])
    op.create_index("ix_place_embeddings_model_id", "place_embeddings", ["model_id"])

    op.create_table(
        "ingest_runs",
        sa.Column("run_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("source", sa.Text, nullable=False),
        sa.Column("coverage_id", sa.String(128), nullable=False),
        sa.Column("polygon", postgresql.JSONB, nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("counts", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("error_summary", sa.Text, nullable=True),
        sa.Column("snapshot_hash", sa.String(64), nullable=True),
        sa.Column("dataset_version", sa.String(64), nullable=True),
        sa.CheckConstraint(
            "status IN ('running','complete','partial','failed')", name="ck_ingest_runs_status"
        ),
    )

    op.create_table(
        "coverage",
        sa.Column("id", sa.String(128), primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("geom", geoalchemy2.Geometry("GEOMETRY", srid=4326, spatial_index=False), nullable=False),
        sa.Column("dataset_version", sa.String(64), nullable=False),
        sa.Column("freshness", sa.DateTime(timezone=True), nullable=False),
        sa.Column("place_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("coverage")
    op.drop_table("ingest_runs")
    op.drop_table("place_embeddings")
    op.drop_table("place_evidence")
    op.drop_table("places")
