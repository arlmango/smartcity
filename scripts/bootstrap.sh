#!/usr/bin/env bash
# Idempotent setup. Does NOT download AI models (see `make models`) and does NOT ingest data.
source "$(dirname "$0")/lib.sh"
if [[ ! -f .env ]]; then cp .env.example .env; log "created .env from .env.example"; fi
set -a; source .env; set +a
log "python deps (uv sync --frozen)"; uv sync --all-packages --frozen
if command -v pnpm >/dev/null 2>&1; then
  log "web deps (pnpm install --frozen-lockfile)"; (cd apps/web && pnpm install --frozen-lockfile)
else
  log "pnpm not found: skipping web deps (needed only for make dev/verify; make up builds the web image in Docker)"
fi
log "database container"; docker compose up -d --build --wait db
log "migrations"; (cd services/api && uv run alembic upgrade head)
log "test databases"; "$(dirname "$0")/test_dbs.sh"
log "bootstrap complete. Next: make models (optional local AI), make ingest, make index, make up"
