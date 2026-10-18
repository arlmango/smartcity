# Доказательства проверки

Заполнено агентом qa-security 2026-10-18. Код под проверкой: **`b4c4eed`** (production без изменений; QA-коммит
добавляет только тесты/скрипты/артефакты/документы). PASS ставится только за реально выполненную на этом commit
проверку. Детали, воспроизведение и severity — [docs/QA_REPORT.md](QA_REPORT.md).

Обозначения среды:
- **DET** — детерминированно: синтетические фикстуры (`tests/fixtures`, `smartcity_test`), fake-провайдеры / `page.route`.
  Команда `make verify` → `artifacts/verify/20261018T202109Z/` (py-test-api 107 passed, py-test-ingest 39 passed,
  web-unit 95 passed, web-e2e 32 passed/3 skipped). Поимённый список pytest: `artifacts/qa/pytest-deterministic-rA.txt`.
- **LIVE** — настоящий web :3000 → API :8000 → PostgreSQL `smartcity` (OSM `osm-20261018T200514Z`, 126 активных мест
  после 20:36 UTC) → Ollama `qwen2.5:3b@357c53fb659c` + `bge-m3@790764642607` (dim 1024), без моков.
  Прогон: `SMARTCITY_LIVE_DEGRADED_WEB_URL=http://127.0.0.1:3011 scripts/smoke_live.sh` → `artifacts/live/20261018T204353Z/`
  (exit 1), повтор S1 → `artifacts/live/20261018T204353Z-S1-rerun/` (exit 0).
- **LIVE-FAIL-PROV** — свой API :8011/:8012 + web :3011, `AI_BASE_URL=EMBEDDING_BASE_URL=http://127.0.0.1:9`
  (настоящий отказ соединения), та же живая БД на чтение.
- Хост: Linux 6.18, 4 vCPU, 15 GiB, без GPU; Chromium 1194 headless (SwiftShader). Firefox/WebKit не установлены.

Повтор `make verify` на QA-коммите `49671fd` (b4c4eed + только тесты/документы QA): тот же результат — 10/11 шагов exit 0,
secret-scan exit 1 (тот же тестовый sentinel), итог exit 2; web-lint/typecheck включают новый `apps/web/tests/live`.
Отчёт: `artifacts/verify/20261018T212250Z/summary.tsv`.

## Функциональные требования A01–A20

| Requirement | Status | Команда / тест | Среда / provider / dataset / commit | Exit | Доказательство |
|---|---|---|---|---|---|
| A01 чистая установка по README | NOT_RUN | Не выполнялась: `make bootstrap`/`up`/`ingest` пересоздали бы общий живой стек и БД. Проверено статически: цели Makefile существуют; README ссылается на отсутствующие `docs/FINAL_REPORT.md`, `docs/DEMO.md` (P2-06); `make up` без профиля ollama (P3-03) | b4c4eed | n/a | `Makefile`, `README.md`, QA_REPORT §README |
| A02 ingest + manifest | NOT_RUN (ingest), артефакт проверен | Ingest не перезапускался по инструкции. Проверены `data/manifests/dataset_manifest.json`, `docs/DATA.md` (источник, лицензия ODbL, counts, hash, дата) и совпадение counts с БД/`/api/map/*` | LIVE, osm-20261018T200514Z | n/a | `data/manifests/*.json`, `artifacts/live/20261018T204353Z/map-desktop-1440.json` |
| A03 идемпотентность/частичный сбой | PASS (DET) | `uv run pytest services/ingest/tests` (T19, T20, T21, retry-failed) | DET, synthetic OSM fixtures, b4c4eed | 0 | `artifacts/qa/pytest-deterministic-rA.txt`, `artifacts/verify/20261018T202109Z/py-test-ingest.log` |
| A04 ≥5 ориентиров по OSM IDs | PASS | `uv run python tests/security/landmarks_check.py data/snapshots/osm-20261018T200514Z data/manifests/landmarks.json data/map …` + live: MEGA (71.4074) отрисован западнее EXPO (71.4214) | сырой снимок osm-20261018T200514Z; LIVE карта | 0 | `artifacts/qa/a04-landmarks-check.json` (way/454857501, 454853233, 1456208623, 499328514, 1196402246, 424894683) |
| A05 3D-контуры, height_source, 2D/3D, pan/zoom/rotate, markers | PASS (LIVE) | `tests/live/map.live.spec.ts` «initial load…» ×3 viewport; маркеры в scenarios | LIVE | 0 (тесты passed) | `artifacts/live/20261018T204353Z/map-*.json`, `screenshots/*-01-initial-3d-map.png`, `*-02-2d-map.png` |
| A06 ручной origin, GPS по запросу, denied, вне покрытия | PASS (LIVE) | map.live «pick origin…», «geolocation denied…» ×3 viewport; API outside_coverage (probe X03) | LIVE; LIVE-FAIL-PROV для X03 | 0 | `screenshots/*-03-outside-coverage-click.png`, `*-04-geolocation-denied.png`, `artifacts/qa/security/probe-validation.json` |
| A07 настоящие embeddings + semantic+geo | PASS | API-лог live: `semantic: ok`, `llm_candidate_ids`; ready: `ollama:bge-m3`, 126 векторов; DET T17/T18 | LIVE bge-m3 dim 1024 | 0 | `artifacts/qa/security/api-container.log`, `artifacts/live/20261018T204353Z/ready.json` |
| A08 настоящий LLM на реальной базе, transcript | PASS (LIVE) | `RUN_LIVE=1 … pytest services/api/tests/test_live.py -m live` (3 passed); браузерные S1/S3/XSS/mobile `mode=live_rag` | LIVE qwen2.5:3b | 0 | `artifacts/live/S1.json`, `S2_relaxed.json`, `S3.json`, `artifacts/qa/pytest-live-RUN_LIVE.log`, `artifacts/live/*/responses/` |
| A09 факты из БД, ID карточек = маркеров, неизвестный ID отклонён | PASS | `tests/security/fact_check.py` (23 рекомендации, 0 расхождений); live `expectCardsMatchMarkers`; DET T14 | LIVE + DET | 0 | `artifacts/qa/fact-check-run1.json`, `artifacts/qa/fact-check-s1-rerun.json` |
| A10 S1–S3, честный no_match | **FAIL** | live: S2 passed, S3 passed, S1 — первый прогон FAIL (браузерный таймаут 150 с, P1-01), повтор passed; mobile 390 passed | LIVE | 1 (smoke) / 0 (повтор) | `artifacts/live/20261018T204353Z/playwright-live.log`, `artifacts/live/20261018T204353Z/s1-failure/`, `screenshots/desktop-1440-20-S2-no-match.png`, `-21-S2-relaxed.png`, `-30-S3-child.png` |
| A11 бюджет каждой альтернативы, «по прямой» | PASS | `checkInvariants` в каждом live-ответе; fact_check (сумма, буфер max(5, ⌈10%⌉), return=outbound, haversine ±2 м, outbound = ⌈d·1.3/66.7⌉); DET T07/T08 | LIVE + DET | 0 | `artifacts/qa/fact-check-*.json` |
| A12 часы в Asia/Almaty, unknown ≠ open, окно start_time | PASS | DET T09–T12; live: все unknown показаны «Часы не указаны»; probe V15/V16 (прошлое/naive start_time → 422) | DET + LIVE + LIVE-FAIL-PROV | 0 | `artifacts/live/20261018T204353Z-S1-rerun/screenshots/desktop-1440-11-unknown-hours-card.png`, `probe-validation.json` |
| A13 уточнения сохраняют hard; гонки | PASS | live S1-rerun: «Поближе» (max_distance 400, budget/return сохранены), «Без кафе» (+exclude cafe, max_distance сохранён), «Только внутри» (+indoor, все результаты indoor-verified); live cancel → новый запрос побеждает; DET T24 (поздний ответ) | LIVE + DET | 0 | `artifacts/live/20261018T204353Z-S1-rerun/responses/*-2..4.json`, `artifacts/live/20261018T204353Z/cancel-stale.json` |
| A14 реальный датасет, source/updated/unknown видны | PASS | live карточки: ссылка «Источник: OpenStreetMap» = server URL, «Данные на …», unknown-признаки; 126 мест, 0 fake | LIVE | 0 | `docs/DATA.md`, screenshots S1 |
| A15 no-WebGL fallback, mobile, keyboard, loading/error/empty | PASS (fallback — только DET) | DET e2e «WebGL unavailable → SVG fallback»; LIVE mobile 390/360, Tab-порядок, progress/cancel, error (P1-01 видна как корректная карточка ошибки), no_match | DET + LIVE | 0 | `artifacts/verify/20261018T202109Z/web-e2e.log`, `keyboard-tab-order-*.json`, `screenshots/mobile-*` |
| A16 rate limit, validation, timeouts, secret scan, XSS/SSRF/PI, логи | **FAIL** | probe (84/85), rate limit обходится XFF (P2-01), логи чистые, XSS/PI live PASS, SSRF 422/404 | LIVE + LIVE-FAIL-PROV | 1 | `artifacts/qa/security/*.json`, `rate-limit-bypass-live-3000.txt`, `api-container.log` |
| A17 все тесты на финальном commit, без скрытых skip | **FAIL** | `make verify` exit 2 (secret-scan, P2-02); `smoke_live.sh` api-шаг: 3 skipped (P2-03) | DET + LIVE | 2 / 1 | `artifacts/verify/20261018T202109Z/summary.tsv`, `artifacts/live/20261018T204353Z/pytest-live.log` |
| A18 независимый reviewer + перепроверка QA | NOT_RUN | Роль reviewer вне границ этого агента; QA-перепроверка исправлений не выполнялась (исправлений ещё нет) | — | n/a | — |
| A19 README/env/bootstrap/backup/restore/privacy/licenses/demo | **FAIL** | `make backup-test` PASS; нет `docs/DEMO.md`, `docs/FINAL_REPORT.md` (P2-06) | LIVE БД (бэкап во временную БД, удалена) | 0 / n/a | `artifacts/qa/backup-test.out` |
| A20 каждый видимый контрол работает, нет фиктивных | PASS | live: 2D/3D, север, +/−, «Показать результаты», карточка↔маркер, Поближе/Без кафе/Только внутри, relaxation, «Начать заново», «Отменить», геолокация, поиск, демо-точка, Карта/Список. «Другие варианты» и «Изменить запрос» — только DET | LIVE + DET | 0 | playwright-live.log, s1-rerun.log |

## Edge cases T01–T30
Все DET-тесты — `make verify` (py-test-api, py-test-ingest, web-unit, web-e2e) на b4c4eed, exit шага 0; поимённо в
`artifacts/qa/pytest-deterministic-rA.txt`. LIVE-колонка — дополнительная проверка на живом стеке.

| ID | Status DET | DET тест | Status LIVE | LIVE проверка / доказательство |
|---|---|---|---|---|
| T01 query empty/long/Unicode | PASS | `test_T01_query_empty_long_unicode` | PASS | probe V07 (2001 → 422), X05 (эмодзи/CJK/казахский → 200), X06 (пустой → 200) — `probe-validation.json` |
| T02 invalid/NaN coords | PASS | `test_T02_invalid_coordinates` | PASS | V01–V03, V21–V23 (NaN/±Infinity → 422), V28 bbox NaN |
| T03 outside coverage | PASS | `test_T03_outside_coverage` | PASS | X03 (`outside_coverage`), браузер: клик вне полигона отклонён |
| T04 no candidates | PASS | `test_T04_no_candidates`, `test_T04_empty_database` | PASS | X04 (10 мин + только культура → no_match с объяснением) |
| T05 hard socket unknown → exclude | PASS | `test_T05_hard_socket_requires_verified_yes`, `test_T05_S2_no_match_and_relaxation_patch` | PASS | S2 live: no_match + `feature_to_preference:socket`; mobile-360 |
| T06 preferred socket unknown not claimed | PASS | `test_T06_preference_socket_unknown_not_claimed`, `test_T06_T28_…` | PASS | S2 relaxed: socket не в verified, «Наличие розеток не подтверждено» |
| T07 exact budget boundary/buffer | PASS | `test_T07_exact_budget_boundary_and_buffer`, `test_T07_api_budget_never_exceeded` | PASS | fact_check: total=40 ровно в нескольких ответах, буфер по формуле |
| T08 return + asymmetric legs | PASS | `test_T08_return_included_and_asymmetric_legs` | PASS (симметрия) | return=outbound во всех live-ответах; асимметрия только DET (роутера нет) |
| T09 closing before arrival | PASS | `test_T09_closing_before_arrival`, `test_T09_closed_before_arrival_relaxation` | n/a | live-логи: `exclusions.closed` ночью (01–03 Астана) |
| T10 closing during visit | PASS | `test_T10_closing_during_visit` | NOT_RUN | — |
| T11 unknown hours | PASS | `test_T11_unknown_hours_variants`, `test_T09_T10_T11_must_be_open` | PASS | все unknown в UI «Часы не указаны», не «открыто» |
| T12 past midnight local | PASS | `test_T12_hours_past_midnight_local_zone`, `test_T12_past_midnight_local` | NOT_RUN | — |
| T13 invalid LLM JSON | PASS | `test_T13_*` (3) | PASS | live: `invalid:…` → повтор → live_rag (20:58) или retrieval_only (20:51) — `api-container.log` (P2-07) |
| T14 unknown place_id | PASS | `test_T14_*` (2) | PASS | XSS/PI live: `fake-0000` не появился; все ID — UUID БД |
| T15 prompt injection | PASS | `test_T15_*` (3) | PASS | live инъекция в запросе: нет утечки промпта/выдуманного места (`desktop-1440-40-xss-injection.png`); eval D10 |
| T16 LLM timeout/429 | PASS | `test_T16_llm_timeout_or_429_degrades`, `test_T16_circuit_breaker_…` | PASS | LIVE-FAIL-PROV: `llm_unavailable` retrieval_only; живой лог 20:30 `provider_timeout` → retrieval_only |
| T17 embeddings down | PASS | `test_T17_embedding_provider_down` | PASS | LIVE-FAIL-PROV: `embeddings_unavailable`, баннер «Поиск по смыслу недоступен» |
| T18 dimension mismatch | PASS | `test_T18_dimension_or_model_mismatch` | NOT_RUN | — |
| T19 node/way duplicate | PASS | `test_T19_*` (2) | n/a | live: «Мега Силк Вей» node деактивирован при повторном import 20:36 (не мной) |
| T20 partial ingest failure | PASS | `test_T20_*` (2) | NOT_RUN | ingest не запускался |
| T21 removed POI after full snapshot | PASS | `test_T21_removed_poi_deactivated_only_after_complete_snapshot` | NOT_RUN | — |
| T22 coord order / holes | PASS | `test_T22_*` (2) | PASS | landmarks_check центроиды [lon,lat] Δ ≤ 0.1 м; 12 зданий с дырами в слое |
| T23 no routing → no fake line | PASS | `test_T23_route_unavailable` | PASS | probe P11 `/api/route` → 501; `route=null`, `method=geodesic` во всех ответах |
| T24 stale response | PASS | web unit «T24: stale responses never overwrite…» | PASS (частично) | live cancel: показан только ответ нового `client_request_id`; поздний ответ live не воспроизводим |
| T25 XSS in place/query | PASS | `test_T25_*` (2), web unit + e2e T25 | PASS | live query XSS: `window.__xss` undefined, DOM без активного HTML; API X01 не отражает HTML |
| T26 arbitrary URL / SSRF | PASS | `test_T26_unsafe_website_dropped`, `test_T26_user_cannot_set_provider_or_source_urls` | PASS | V10–V12 (422), P01–P10, W01–W12 (404 / same-origin 308→404), ссылки только `https://www.openstreetmap.org/…` |
| T27 negative duration / min>max | PASS | `test_T27_*` (2) | PASS | V04–V06 → 422 |
| T28 unknown kids/accessibility | PASS | `test_T28_unknown_kids_and_wheelchair` | FAIL (текст ИИ) | S3: kids только у площадок (verified tag) — ok; но eval H03: «место на улице» при outdoor_seating=unknown (P2-08) |
| T29 duplicate recommendations | PASS | `test_T29_*` (2) | PASS | 0 дублей place_id в live; но 2–3 безымянные площадки (P2-04) |
| T30 LLM can't overwrite facts | PASS | `test_T30_*` (2) | PASS (поля) / FAIL (текст) | fact_check: все поля из БД, 0 расхождений; но текст ИИ противоречит return_to_start (P1-02) |

## Browser E2E / accessibility / performance

| Пункт | Status | Команда | Среда | Exit | Доказательство |
|---|---|---|---|---|---|
| Deterministic E2E 1440/390/360 | PASS | `pnpm test:e2e` (в make verify) | DET, Chromium | 0 | `artifacts/verify/20261018T202109Z/web-e2e.log` |
| Live E2E desktop 1440 | FAIL (1 из 13: S1, P1-01), повтор PASS | `pnpm exec playwright test -c playwright.live.config.ts` | LIVE Chromium | 1 / 0 | `artifacts/live/20261018T204353Z/playwright-live.log`, `playwright-live.json`, `artifacts/qa/s1-rerun.log` |
| Live E2E mobile 390 | PASS (5/5) | то же, проект mobile-390 | LIVE | 0 | `screenshots/mobile-390-*` |
| Live E2E mobile 360 | PASS (5/5) | проект mobile-360 | LIVE | 0 | `screenshots/mobile-360-*` |
| Provider failure UI | PASS | проект degraded-1440 | LIVE-FAIL-PROV | 0 | `screenshots/degraded-1440-70-provider-failure-retrieval-only.png` |
| Firefox / WebKit smoke | NOT_RUN | браузеры не установлены в `/opt/pw-browsers` | — | n/a | `ls /opt/pw-browsers` |
| Скриншоты (initial, 3D, recommendations, selected, mobile, no-match, unknown hours, provider failure) | PASS | live suite | LIVE | 0 | `artifacts/live/20261018T204353Z/screenshots/`, `artifacts/live/20261018T204353Z-S1-rerun/screenshots/` |
| Console errors / network failures | PASS | collectors в live suite | LIVE | 0 | `artifacts/live/*/console/*.json` (единственное — ожидаемый ERR_ABORTED при отмене) |
| axe | PASS (0 нарушений) | `@axe-core/playwright` initial ×3, results ×2 | LIVE | 0 | `artifacts/live/20261018T204353Z*/axe-*.json` |
| Клавиатура / focus-visible / контраст / reduced motion | PASS | map.live «keyboard…», scenarios S1 Tab-порядок, axe color-contrast, «reduced motion» | LIVE | 0 | `keyboard-tab-order-*.json` |
| Performance page/map-ready | PASS (измерено) | map.live «perf…» | LIVE, Chromium headless SwiftShader | 0 | `artifacts/live/20261018T204353Z/perf-page-load.json` |
| API latency read endpoints | PASS (измерено) | `tests/security/latency.py … 30` | LIVE :8000, concurrency 1 | 0 | `artifacts/qa/perf/api-latency-live.json` |
| `/api/recommend` latency | измерено (мало точек): eval live_rag n=15 p50 56 с, p95 73 с; браузер 28–124 с + 1 обрыв на 150 с | live suite + eval | LIVE CPU | 0 | QA_REPORT §Eval |
| Память контейнеров | измерено | `docker stats --no-stream` | LIVE | 0 | `artifacts/qa/perf/docker-stats-during-eval.txt` |
| Secret scan | FAIL (ложное срабатывание, P2-02) | `uv run python scripts/secret_scan.py` | b4c4eed | 1 | `artifacts/verify/20261018T202109Z/secret-scan.log` |
| Dependency audit | FAIL (P2-05) | `uvx pip-audit -r <uv export>`; `pnpm audit --prod` | сеть через прокси | 1 / 1 | `artifacts/qa/audit/` |
| Backup/restore | PASS | `make backup-test` | LIVE БД | 0 | `artifacts/qa/backup-test.out` |
| Eval 20 запросов (10 dev + 10 holdout) | PASS (0 violations; 2 misses) | `make eval` | LIVE qwen2.5:3b + bge-m3, 126 мест | 0 | `artifacts/eval/20261018T210726Z/summary.md`, `results.json` |
