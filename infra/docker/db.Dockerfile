# PostgreSQL 17 + pgvector 0.8.1 + PostGIS 3.6 (pinned).
FROM pgvector/pgvector:0.8.1-pg17-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17-postgis-3=3.6.4+dfsg-2.pgdg12+1 postgresql-17-postgis-3-scripts=3.6.4+dfsg-2.pgdg12+1 \
 && rm -rf /var/lib/apt/lists/*
COPY infra/docker/db-init.sql /docker-entrypoint-initdb.d/00-extensions.sql
