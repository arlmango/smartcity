#!/usr/bin/env bash
# Backup -> restore into scratch DB -> compare row counts -> drop scratch DB.
source "$(dirname "$0")/lib.sh"
dump=$("$(dirname "$0")/backup.sh" smartcity | tail -1)
target=$("$(dirname "$0")/restore.sh" "$dump" | tail -1)
q="SELECT (SELECT count(*) FROM places)||','||(SELECT count(*) FROM place_evidence)||','||(SELECT count(*) FROM place_embeddings)||','||(SELECT count(*) FROM ingest_runs)||','||(SELECT md5(string_agg(id::text||content_hash||active::text, ',' ORDER BY id)) FROM places)||','||(SELECT md5(string_agg(place_id::text||model_id||content_hash, ',' ORDER BY place_id, model_id)) FROM place_embeddings)"
a=$(docker compose exec -T db psql -U smartcity -d smartcity -Atc "$q")
b=$(docker compose exec -T db psql -U smartcity -d "$target" -Atc "$q")
docker compose exec -T db psql -U smartcity -d postgres -qc "DROP DATABASE $target"
log "counts places,evidence,embeddings,runs + content checksums (places, embeddings): source=$a restored=$b"
[[ "$a" == "$b" ]] || die "backup-test FAILED: counts differ"
log "backup-test PASS ($dump)"
