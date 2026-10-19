#!/usr/bin/env bash
# Incremental embeddings index for active places (model from EMBEDDING_* settings in .env).
# Usage: scripts/index.sh [--prune-other-models]
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"
# Local default: make sure the compose Ollama service (profile `ollama`) is running.
if [[ "${EMBEDDING_PROVIDER:-ollama}" == "ollama" ]] && ! curl -s -m 3 "${EMBEDDING_BASE_URL:-http://localhost:11434}/api/tags" >/dev/null; then
  log "starting compose ollama for embeddings"
  docker compose --profile ollama up -d --wait ollama
fi
exec "$ROOT/scripts/ingest.sh" index "$@"
