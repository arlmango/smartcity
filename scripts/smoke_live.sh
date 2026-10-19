#!/usr/bin/env bash
# LIVE smoke: real frontend + API + DB + OSM snapshot + real embeddings + real LLM. No network mocks.
# Cannot PASS when the LLM or embeddings are unavailable.
source "$(dirname "$0")/lib.sh"
set +e
API="${SMOKE_API_URL:-http://127.0.0.1:${API_PORT:-8000}}"
WEB="${SMOKE_WEB_URL:-http://127.0.0.1:${WEB_PORT:-3000}}"
ts=$(date -u +%Y%m%dT%H%M%SZ); out="artifacts/live/$ts"; mkdir -p "$out"
commit=$(git rev-parse --short HEAD)
# Readiness may report a probe as still running right after a (cold) model load: wait up to 180 s
# for every required component to be ok; the requirement itself is unchanged.
for _ in $(seq 1 36); do
  curl -s -m 60 "$API/api/ready" > "$out/ready.json"
  python3 - "$out/ready.json" >/dev/null 2>&1 <<'PY' && break
import json, sys
c = json.load(open(sys.argv[1])).get("components", {})
sys.exit(0 if all(c.get(k, {}).get("status") == "ok" for k in ("db", "data", "map", "embeddings", "llm")) else 1)
PY
  sleep 5
done
python3 - "$out/ready.json" <<'PY' || { echo "LIVE SMOKE: BLOCKED — API not ready or LLM/embeddings unavailable (see $out/ready.json)"; exit 2; }
import json, sys
r = json.load(open(sys.argv[1]))
c = r.get("components", {})
bad = [k for k in ("db", "data", "map", "embeddings", "llm") if c.get(k, {}).get("status") != "ok"]
print("components:", {k: v.get("status") for k, v in c.items()})
sys.exit(1 if bad else 0)
PY
overall=0
log "== api live scenarios (pytest -m live)"
RUN_LIVE=1 SMARTCITY_LIVE_API_URL="$API" SMARTCITY_LIVE_ARTIFACTS="$out" uv run pytest services/api/tests -m live -q -p no:cacheprovider > "$out/pytest-live.log" 2>&1; rc=$?
echo "pytest-live exit=$rc"; [[ $rc -eq 0 ]] || overall=1
# Live tests must actually run: a run with skips is not a live PASS.
if grep -qE "[0-9]+ skipped" "$out/pytest-live.log" || ! grep -qE "[0-9]+ passed" "$out/pytest-live.log"; then
  echo "pytest-live: tests were skipped or none passed -> FAIL"; overall=1
fi
log "== browser live scenarios (Playwright, no mocks)"
(cd apps/web && SMARTCITY_LIVE_WEB_URL="$WEB" SMARTCITY_LIVE_ARTIFACTS="$ROOT/$out" pnpm exec playwright test -c playwright.live.config.ts) > "$out/playwright-live.log" 2>&1; rc=$?
echo "playwright-live exit=$rc"; [[ $rc -eq 0 ]] || overall=1
{
  echo "commit: $commit"; echo "date: $(date -u +%FT%TZ)"
  echo "api: $API web: $WEB"
  echo "dataset_manifest_sha256: $(sha256sum data/manifests/dataset_manifest.json 2>/dev/null | cut -d' ' -f1)"
  echo "overall_exit: $overall"
} > "$out/summary.txt"
cat "$out/summary.txt"; log "report: $out"
exit $overall
