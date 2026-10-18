#!/usr/bin/env bash
# Bounded OSM ingest (Overpass, read-only) -> DB, map layers, embeddings, reports.
# Usage: scripts/ingest.sh [all|fetch|import|build-map|report|landmarks] [--from-snapshot <version>] ...
# Logs go to artifacts/ingest/ (no secrets are printed by the CLI).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p artifacts/ingest
cmd="${1:-all}"; shift || true
ts="$(date -u +%Y%m%dT%H%M%SZ)"
set +e
uv run smartcity-ingest "$cmd" "$@" 2>&1 | tee "artifacts/ingest/${ts}-${cmd}.txt"
rc=${PIPESTATUS[0]}
echo "exit_code=${rc}" | tee -a "artifacts/ingest/${ts}-${cmd}.txt"
exit "$rc"
