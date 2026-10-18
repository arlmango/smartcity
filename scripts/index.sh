#!/usr/bin/env bash
# Incremental embeddings index for active places (model from EMBEDDING_* settings in .env).
# Usage: scripts/index.sh [--prune-other-models]
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"
exec "$ROOT/scripts/ingest.sh" index "$@"
