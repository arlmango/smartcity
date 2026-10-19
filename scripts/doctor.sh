#!/usr/bin/env bash
# Environment check. Prints versions, resources, port usage and provider reachability.
# Never prints secret values (only whether they are set).
source "$(dirname "$0")/lib.sh"
fail=0
check() { if command -v "$1" >/dev/null 2>&1; then printf '  %-8s %s\n' "$1" "$($1 --version 2>&1 | head -1)"; else printf '  %-8s MISSING\n' "$1"; fail=1; fi; }
echo "Tools:"; for t in docker uv node pnpm make; do check "$t"; done
docker compose version >/dev/null 2>&1 && echo "  compose  $(docker compose version --short)" || { echo "  compose  MISSING"; fail=1; }
docker info >/dev/null 2>&1 && echo "  dockerd  running" || { echo "  dockerd  NOT RUNNING (start Docker; in a bare container: dockerd &)"; fail=1; }
echo "Resources:"
echo "  cpu      $(nproc) cores"
echo "  memory   $(free -g | awk '/Mem:/{print $2" GiB total, "$7" GiB available"}')"
echo "  disk     $(df -h "$ROOT" | awk 'NR==2{print $4" free"}')"
command -v nvidia-smi >/dev/null 2>&1 && echo "  gpu      $(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)" || echo "  gpu      none (CPU inference only)"
echo "Env:"
[[ -f .env ]] && echo "  .env     present" || echo "  .env     missing (make bootstrap copies .env.example)"
for v in AI_API_KEY EMBEDDING_API_KEY; do [[ -n "${!v:-}" ]] && echo "  $v set" || echo "  $v empty"; done
echo "  AI_PROVIDER=${AI_PROVIDER:-ollama} AI_MODEL=${AI_MODEL:-qwen2.5:3b} EMBEDDING_MODEL=${EMBEDDING_MODEL:-bge-m3} ROUTING_PROVIDER=${ROUTING_PROVIDER:-none}"
echo "Ports (127.0.0.1):"
for p in "$DB_PORT" "${API_PORT:-8000}" "${WEB_PORT:-3000}" 11434; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then echo "  $p in use"; else echo "  $p free"; fi
done
echo "Providers:"
probe() { local code; code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$2" || true); echo "  $1 -> HTTP ${code:-000}"; }
if [[ "${AI_PROVIDER:-ollama}" == "ollama" ]]; then
  probe "ollama ${AI_BASE_URL:-http://localhost:11434}" "${AI_BASE_URL:-http://localhost:11434}/api/tags"
  models=$(curl -s -m 8 "${AI_BASE_URL:-http://localhost:11434}/api/tags" | python3 -c 'import json,sys
try: print(",".join(m["name"] for m in json.load(sys.stdin)["models"]))
except Exception: print("")' || true)
  echo "  ollama models: ${models:-none} (need ${AI_MODEL:-qwen2.5:3b} and ${EMBEDDING_MODEL:-bge-m3}; see make models)"
else
  probe "ai endpoint (no auth probe)" "${AI_BASE_URL}/models"
fi
probe "overpass ${OSM_SOURCE_URL:-https://maps.mail.ru/osm/tools/overpass/api/interpreter}" "$(dirname "${OSM_SOURCE_URL:-https://maps.mail.ru/osm/tools/overpass/api/interpreter}")/status"
exit $fail
