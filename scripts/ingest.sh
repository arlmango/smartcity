#!/usr/bin/env bash
# Bounded OSM ingest (Overpass, read-only) -> DB, map layers, embeddings, reports.
# Usage: scripts/ingest.sh [all|fetch|import|build-map|index|report|landmarks] [--from-snapshot <version>] ...
# lib.sh cds to the repo root and exports .env (DATABASE_URL, EMBEDDING_*, OSM_SOURCE_URL, ...).
# Logs go to artifacts/ingest/<ts>-<cmd>.txt (no secrets are printed by the CLI); exit code is preserved.
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"
mkdir -p artifacts/ingest
cmd="${1:-all}"; shift || true
ts="$(date -u +%Y%m%dT%H%M%SZ)"
logfile="artifacts/ingest/${ts}-${cmd}.txt"
log "smartcity-ingest ${cmd} $* -> ${logfile}"
set +e
uv run smartcity-ingest "$cmd" "$@" 2>&1 | tee "$logfile"
rc=${PIPESTATUS[0]}
set -e
echo "exit_code=${rc}" | tee -a "$logfile"
exit "$rc"
