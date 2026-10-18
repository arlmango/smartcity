#!/usr/bin/env bash
# Pull local models into the compose `ollama` service. Explicit opt-in only.
source "$(dirname "$0")/lib.sh"
GEN="${AI_MODEL:-qwen2.5:3b}"; EMB="${EMBEDDING_MODEL:-bge-m3}"
cat <<MSG
Local models for SmartCity (CPU inference):
  generation  $GEN   download ~1.9 GB, RAM ~3 GB (Qwen Research License; non-commercial demo)
  embeddings  $EMB   download ~1.2 GB, RAM ~1.5 GB (MIT)
Total disk ~3.1 GB in docker volume smartcity_ollama.
MSG
[[ "${CONFIRM:-0}" == "1" ]] || die "re-run with CONFIRM=1 make models to download"
if curl -s -m 3 http://127.0.0.1:11434/api/tags >/dev/null; then
  log "an Ollama server already listens on :11434; pulling there"
  for m in "$GEN" "$EMB"; do curl -sS -m 1800 http://127.0.0.1:11434/api/pull -d "{\"model\":\"$m\",\"stream\":false}"; echo; done
else
  extra=()
  [[ -n "${OLLAMA_EXTRA_CA_BUNDLE:-}" ]] && extra=(-f docker-compose.yml -f infra/compose.ollama-ca.yml)
  docker compose "${extra[@]}" --profile ollama up -d --wait ollama
  for m in "$GEN" "$EMB"; do docker compose "${extra[@]}" exec -T ollama ollama pull "$m"; done
fi
log "models ready"
