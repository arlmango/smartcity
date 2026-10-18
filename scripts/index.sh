#!/usr/bin/env bash
# Incremental embeddings index for active places (model from EMBEDDING_* settings).
# Usage: scripts/index.sh [--prune-other-models]
set -euo pipefail
cd "$(dirname "$0")/.."
exec scripts/ingest.sh index "$@"
