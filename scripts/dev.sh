#!/usr/bin/env bash
# Local development: API with reload on :8000 and Next.js dev on :3000 (Ctrl+C stops both).
source "$(dirname "$0")/lib.sh"
docker compose up -d --wait db
(cd services/api && uv run alembic upgrade head)
trap 'kill 0' EXIT
(cd services/api && uv run uvicorn smartcity_api.main:app --host 127.0.0.1 --port "${API_PORT:-8000}" --reload) &
(cd apps/web && API_INTERNAL_URL="http://127.0.0.1:${API_PORT:-8000}" pnpm exec next dev -p "${WEB_PORT:-3000}") &
wait
