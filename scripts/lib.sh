# Shared helpers for SmartCity scripts. Sourced, not executed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [[ -f .env ]]; then
  set -a; # shellcheck disable=SC1091
  source .env; set +a
fi
DB_PORT="${DB_PORT:-5433}"
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
db_ready() { docker compose exec -T db pg_isready -U smartcity -d smartcity >/dev/null 2>&1; }
