#!/usr/bin/env bash
# Restore a dump. Default: into a NEW database smartcity_restore_<ts> (never silently overwrites).
# FORCE=1 replaces `smartcity` after taking an automatic safety backup first.
source "$(dirname "$0")/lib.sh"
BACKUP="${1:-}"
[[ -n "$BACKUP" && -f "$BACKUP" ]] || die "usage: make restore BACKUP=data/backups/<file>.dump"
if [[ -f "$BACKUP.sha256" ]]; then sha256sum -c "$BACKUP.sha256" >/dev/null || die "checksum mismatch for $BACKUP"; fi
psqlc() { docker compose exec -T db psql -U smartcity -d postgres -v ON_ERROR_STOP=1 -qc "$1"; }
if [[ "${FORCE:-0}" == "1" ]]; then
  log "FORCE=1: safety backup of current smartcity first"
  "$(dirname "$0")/backup.sh" smartcity >/dev/null
  target="smartcity_restore_tmp_$$"
  psqlc "CREATE DATABASE $target OWNER smartcity"
  docker compose exec -T db pg_restore -U smartcity -d "$target" --no-owner < "$BACKUP"
  log "stop api/web to release connections"; docker compose stop api web >/dev/null 2>&1 || true
  psqlc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='smartcity' AND pid<>pg_backend_pid()" >/dev/null
  psqlc "ALTER DATABASE smartcity RENAME TO smartcity_replaced_$(date -u +%Y%m%d%H%M%S)"
  psqlc "ALTER DATABASE $target RENAME TO smartcity"
  log "smartcity replaced; previous database kept as smartcity_replaced_*; start services with make up"
else
  target="smartcity_restore_$(date -u +%Y%m%d%H%M%S)"
  psqlc "CREATE DATABASE $target OWNER smartcity"
  docker compose exec -T db pg_restore -U smartcity -d "$target" --no-owner < "$BACKUP"
  log "restored into NEW database $target (smartcity untouched). Inspect, or re-run with FORCE=1 to replace."
fi
echo "$target"
