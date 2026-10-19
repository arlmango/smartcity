#!/usr/bin/env bash
# pg_dump (custom format) of the smartcity database into data/backups/.
source "$(dirname "$0")/lib.sh"
DB="${1:-smartcity}"
mkdir -p data/backups
out="data/backups/${DB}-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T db pg_dump -U smartcity -d "$DB" -Fc > "$out"
sha256sum "$out" > "$out.sha256"
log "backup written: $out ($(du -h "$out" | cut -f1))"
echo "$out"
