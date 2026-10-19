# SmartCity: local pedestrian routes, 19 October 2026

Implemented in isolated branch `improve/alternatives-20261019`, based on submission `c4c1b8d`.
Real Valhalla walking geometry now determines recommendation budgets before facts are shown and before RAG.
Outbound and return legs are calculated separately; estimated approach gaps are added to each leg.
No invented connecting segment is drawn. A short access warning remains visible; technical details and
sources are available under «Подробнее и источники». The main map legend and workflow use plain Russian.
Height details start collapsed, and the mobile «О данных» panel scrolls within the screen.

## What changed

- Local-only routing adapter, validated geometry, pilot bounds and 100 m snap limit. Default configuration stays
  `none`; transport failure/8-second or 256-call limit yields explicit estimates without a line. No-path candidates
  are excluded, including relaxations. Network distance and the existing geodesic UI constraint are separate.
- Each recommendation carries its route, graph/source metadata, separate return and access estimates.
  LLM cannot rewrite these values. Preliminary and final cards keep selection and route/camera stable.
- Map shows bent real outbound and return geometry, endpoints on the network, smooth fit/fade and reduced-motion
  support. Reset, new request and changed start hide stale routes. Same-route selection after panning recentres.
- Compact alternative comparison from the earlier iteration is retained. Sources, raw hours, diagnostic details
  and provenance are disclosed on demand; unknown hours, unconfirmed required conditions and missing paths remain visible.

## Source and graph evidence

See `STATUS.md`, `control-audit.json`, `control-lines.geojson`, `volume-build.log`.
Three public OSM controls, each independently routed outward/back. Geometries contain 50–98 vertices per leg,
match source highway geometry within 0.06 m at 5 m sampling, and bend around buildings. The Mega control's direct
segment crosses 243.68 m of building interiors; routed line crosses 0 m. Elevated `building=roof` canopy excluded.
This verifies graph/source geometry, not today's physical access. Mega's 83.76 m centroid gap remains unverified.
The graph is built within the approved limits; no external routing API, real user GPS or paid key was used.

## Measurements

These are observed single runs, not a controlled performance benchmark:

| Run | First factual cards | Final state | Outcome |
| --- | ---: | ---: | --- |
| Before routing, earlier comparison iteration |5.832 s|65.288 s|live RAG, geodesic estimates|
| First routed run |3.612 s|53.679 s|live RAG; routing stage 1.819 s for 70 candidates|
| Routed run during parallel E2E load |7.343 s|156.807 s|model timeout; route/cards retained, explicit retrieval-only state|
| Final UI, isolated run after reconnect |2.678 s|28.037 s|live RAG, no JS errors|
| Final screenshot confirmation, warmed model |1.495 s|12.639 s|live RAG, route/selection retained|

Earlier evidence: `../iteration/live.json`; routed evidence: `first-live-metrics.json`,
`loaded-live.json`, `loaded-live-api-metrics.json`. The timed-out run has identical preliminary/final selected
ID and route geometry (64 outward/65 return vertices), zero JS errors, and reset removes both endpoints/legend.
Streaming factual cards existed before this work; no claim of model-inference speedup is made.

## Validation

- API full suite 200 PASS/3 SKIP (opt-in live-AI scenarios). Routing cases include real localhost Valhalla, samepoint, bent/asymmetric
  paths, malformed geometry, coverage, snap gaps, timeout/no-path, budget boundary and 256-call cleanup.
- Ingest compatibility suite 54 PASS/1 deselected; source data was not rebuilt.
- Web unit 154 PASS; production Next build, ESLint, TypeScript and Python Ruff checks PASS.
- OpenAPI snapshot is up to date. Build-wrapper cleanup 2 PASS (mock timeout/KeyboardInterrupt stop→kill).
- Functional production Chromium 42 E2E PASS before the final copy/disclosure simplification: desktop 1440 and
  mobile 390/360, selection, separate return, reset/repeat/stale start, same-route refocus, reduced motion, errors,
  no graph, cancellation, WebGL fallback, offline, keyboard and axe.
- Independent review's three P2 findings fixed and re-reviewed; no remaining P1/P2. See `REVIEW.md`.

After the final copy/disclosure changes and main integration: full deterministic Chromium suite 62 PASS/4 SKIP
(three opt-in screenshot utilities and one phone-only test on desktop); desktop 1440, mobile 390/360. This includes route disclosure, collapsed height legend,
CSP, map/satellite consent, proxy headers and the complete flow suite. See `e2e.log`.

Not run: the `make verify` wrapper itself (its constituent checks were run separately), ingest rebuild, expanded graph, new Firefox/WebKit checks,
physical low-end phone/GPU, field verification of entrances/crossings. CPU throttling is not a mobile-GPU test.
Model timeout under load is a retained limitation, not a hidden PASS. Source opening hours are not independently verified.

## Handoff and preservation

Remote rechecked after permission to publish: PR1 is merged, main `7769ee001ae1a56dd2494b6d503b0da2b0bfabea`.
Its tree is identical to submission `c4c1b8d`; it was safely merged into this feature branch before final validation.
The original local origin is retained; the additional `github` remote points to the public repository.
Publishing through PR and ordinary merge is now authorized; deployment is not.

Original `/Users/mango/smartcity` remains dirty exactly in the previously known manifests/docs and ingest logs;
none of those changes are included or overwritten. Downloads submission MP4/PPTX/ZIP and .env are untouched.
Baseline ports 3000/8000 remain; own preview 3208, API 8108, router 8208 are loopback-only.
Ignored local graph/extract, Docker image/volume and node_modules are not Git deliverables.

To start the separate API from this clone (no .env edits):

```sh
PYTHONPATH=services/api ROUTING_PROVIDER=valhalla ROUTING_BASE_URL=http://127.0.0.1:8208 DATA_DIR=/Users/mango/smartcity/data /Users/mango/smartcity/.venv/bin/python -m uvicorn smartcity_api.main:app --host 127.0.0.1 --port 8108
```

From `apps/web`: `API_INTERNAL_URL=http://127.0.0.1:8108 node scripts/start-standalone.mjs 3208`
Graph reproduction and limits are in `scripts/routing_pilot.py` / `STATUS.md`.


## Final live evidence

Final screenshots: `live-final-desktop.png`, `live-mobile-map.png`, `live-mobile-cards.png`.
All use actual OSM records, local Valhalla and Ollama. Visual review completed. Capture waits for
rendered route features and two animation frames after viewport resize; an earlier immediate capture
was blank before the renderer finished, so it was replaced after confirming real rendering.
The visible map caveat remains on mobile; technical sources are collapsed, map attribution retained.
`live.json` confirms zero JS errors, retained selected ID/geometry and reset with zero route endpoints/legends.
The three final screenshots were also saved to the user's Library.

Implementation commit: `bcf1939` (plus the capture-wait correction in this evidence commit).
The published PR includes code, tests, documentation and small proof artifacts; excludes generated
PBF/tiles, Docker images, models, .env, node_modules and the other checkout's uncommitted data manifests.
