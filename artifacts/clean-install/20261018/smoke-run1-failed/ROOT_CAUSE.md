# Live smoke run 1 (clean clone, commit ca1d8ac) — FAIL, root cause: test environment

- API live 3/3 passed; browser live 23 passed, 2 skipped (project scoping), **1 failed**: `degraded.live.spec.ts`
  (provider-failure scenario on the helper web :3011).
- The helper processes for this scenario (`uvicorn … --port 8011`, `start-standalone.mjs 3011`) started from the
  clean clone could not bind: stale helpers from an earlier run in the main checkout still held both ports.
  The stale Next server served a `.next` directory that had been rebuilt underneath it → `ChunkLoadError`
  → "Application error: a client-side exception".
- Reproduced with a direct browser load of :3011 (ChunkLoadError on `page-*.js`, MIME text/html).
- Fix: stopped the stale processes by port (PIDs 26105, 25929), restarted helpers from the clean clone, reran
  the full smoke (see ../13-smoke-live-final.log). No product code change was needed for this failure.
