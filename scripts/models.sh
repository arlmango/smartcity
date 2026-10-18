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
has_models() {  # $1 = base URL; succeeds only when both models are present
  curl -s -m 5 "$1/api/tags" | python3 -c 'import json,sys
names = {m["name"] for m in json.load(sys.stdin).get("models", [])}
need = [n if ":" in n else n + ":latest" for n in sys.argv[1:]]
sys.exit(0 if all(n in names for n in need) else 1)' "$GEN" "$EMB"
}
if [[ -n "${OLLAMA_EXTRA_CA_BUNDLE:-}" ]]; then
  # Networks with a TLS-intercepting proxy reachable only on the host's loopback (e.g. sandboxed
  # CI): pull with a temporary host-network Ollama into the same compose volume, then stop it.
  vol="${COMPOSE_PROJECT_NAME:-smartcity}_ollama"
  docker volume create "$vol" >/dev/null
  name="smartcity-ollama-pull-$$"
  docker run -d --rm --name "$name" --network host -e OLLAMA_HOST=127.0.0.1:11435 \
    -e HTTPS_PROXY="${HTTPS_PROXY:-}" -v "$vol:/root/.ollama" \
    -v "$OLLAMA_EXTRA_CA_BUNDLE:/etc/ssl/certs/ca-certificates.crt:ro" ollama/ollama:0.12.6 >/dev/null
  trap 'docker stop "$name" >/dev/null 2>&1 || true' EXIT
  for _ in $(seq 1 30); do curl -s -m 2 http://127.0.0.1:11435/api/tags >/dev/null && break; sleep 1; done
  for m in "$GEN" "$EMB"; do docker exec -e OLLAMA_HOST=127.0.0.1:11435 "$name" ollama pull "$m"; done
  has_models http://127.0.0.1:11435 || die "models missing after pull (see errors above)"
elif curl -s -m 3 http://127.0.0.1:11434/api/tags >/dev/null; then
  log "an Ollama server already listens on :11434; pulling there"
  for m in "$GEN" "$EMB"; do curl -sS -m 1800 http://127.0.0.1:11434/api/pull -d "{\"model\":\"$m\",\"stream\":false}"; echo; done
  has_models http://127.0.0.1:11434 || die "models missing after pull (see errors above)"
else
  docker compose --profile ollama up -d --wait ollama
  for m in "$GEN" "$EMB"; do docker compose exec -T ollama ollama pull "$m"; done
  has_models http://127.0.0.1:11434 || die "models missing after pull (see errors above)"
fi
log "models ready"
