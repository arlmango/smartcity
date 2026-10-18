#!/usr/bin/env bash
# Quality gate (deterministic): format/lint/typecheck -> unit+integration -> build -> deterministic E2E.
# Every step runs; the summary lists each exit code; overall exit is nonzero if any step failed.
source "$(dirname "$0")/lib.sh"
set +e
ts=$(date -u +%Y%m%dT%H%M%SZ)
out="artifacts/verify/$ts"; mkdir -p "$out"
commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
dirty=$(git status --porcelain 2>/dev/null | grep -qv '^??' && echo "+dirty" || echo "")
printf 'step\texit\tlog\n' > "$out/summary.tsv"
overall=0
step() {
  local name="$1"; shift
  log "== $name"
  ( "$@" ) > "$out/$name.log" 2>&1
  local rc=$?
  printf '%s\t%s\t%s\n' "$name" "$rc" "$out/$name.log" >> "$out/summary.tsv"
  if [[ $rc -ne 0 ]]; then overall=1; log "   FAIL ($rc) see $out/$name.log"; tail -15 "$out/$name.log"; else log "   ok"; fi
}
docker compose up -d --wait db >/dev/null 2>&1 || log "warning: could not start db (integration tests will fail)"
step py-lint        uv run ruff check services scripts
step py-format      uv run ruff format --check services scripts
step py-test-api    uv run pytest services/api/tests -m "not live" -q
step py-test-ingest uv run pytest services/ingest/tests -m "not live" -q
step web-lint       bash -c "cd apps/web && pnpm lint"
step web-typecheck  bash -c "cd apps/web && pnpm typecheck"
step web-unit       bash -c "cd apps/web && pnpm test"
step web-build      bash -c "cd apps/web && pnpm build"
step web-e2e        bash -c "cd apps/web && pnpm test:e2e"
step secret-scan    uv run python scripts/secret_scan.py
step contracts-sync bash -c "uv run python -m smartcity_api.export_openapi --check"
{
  echo "commit: $commit$dirty"; echo "date: $(date -u +%FT%TZ)"
  echo "env: $(uname -sr), $(nproc) cpu, python $(uv run python -V 2>&1 | cut -d' ' -f2), node $(node -v)"
  echo "overall_exit: $overall"
} > "$out/env.txt"
cat "$out/summary.tsv"; log "report: $out"
exit $overall
