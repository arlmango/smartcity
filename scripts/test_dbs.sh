#!/usr/bin/env bash
# Idempotently create and migrate the throw-away test databases used by the DB-backed test suites
# (smartcity_test for services/api, smartcity_test_ingest for services/ingest). Never touches `smartcity`.
source "$(dirname "$0")/lib.sh"
docker compose up -d --wait db >/dev/null
for db in smartcity_test smartcity_test_ingest; do
  exists=$(docker compose exec -T db psql -U smartcity -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='$db'")
  if [[ "$exists" != "1" ]]; then
    docker compose exec -T db psql -U smartcity -d postgres -qc "CREATE DATABASE $db OWNER smartcity"
    log "created $db"
  fi
  docker compose exec -T db psql -U smartcity -d "$db" -qc "CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS vector;"
  (cd services/api && DATABASE_URL="postgresql+psycopg://smartcity:${POSTGRES_PASSWORD:-smartcity}@localhost:${DB_PORT}/$db" \
    uv run alembic upgrade head >/dev/null)
  log "$db migrated"
done
