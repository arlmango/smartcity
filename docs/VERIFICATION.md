# Доказательства проверки

Актуально на 2026-10-18 (UTC). Итоговый gate выполнен в **чистом клоне** репозитория
(`git clone` → README-последовательность, отдельный compose-проект `smartcityclean`: новые тома БД и моделей,
модели скачаны заново, данные собраны заново из Overpass). Журналы шагов — `artifacts/clean-install/20261018/`.
Итоговый commit gate: **`ba066fe`** — `make verify` 11/11 exit 0 и `make smoke-live` exit 0 в чистом клоне
(`artifacts/clean-install/20261018/final-gate-3/`). Промежуточные прогоны (db7c04f PASS, c468832 FAIL с разбором,
ca1d8ac FAIL из-за среды с разбором) сохранены там же. История ранних прогонов QA (`b4c4eed`) — [QA_REPORT.md](QA_REPORT.md).

Среда: Linux 6.18, 4 vCPU, 15 GiB RAM, без GPU; Docker 29.8.2 / Compose 5.6.0; Python 3.13.16 (uv 0.11.32);
Node 22.22.0 (pnpm 10.28.0); Chromium 1194 headless (SwiftShader WebGL). Firefox/WebKit не установлены — не запускались.
Провайдеры (LIVE): Ollama 0.12.6, генерация `qwen2.5:3b@357c53fb659c`, embeddings `bge-m3@790764642607` (dim 1024).
Датасет (чистая установка): `osm-20261018T223058Z`, снимок complete, sha256 `85ff9338…b367`, 126 активных мест.

Обозначения: **DET** — детерминированные тесты на синтетических фикстурах (`tests/fixtures`, БД `smartcity_test*`,
fake-провайдеры только в `tests/`, `page.route` в E2E). **LIVE** — настоящие web → API → PostgreSQL → Ollama, без
моков. **LIVE-FAIL** — второй настоящий экземпляр API/web с недоступными провайдерами (connection refused), та же БД.

## Сводка команд (чистый клон)

| Шаг | Команда | Exit | Журнал |
|---|---|---|---|
| doctor | `make doctor` | 0 | `artifacts/clean-install/20261018/01-doctor.log` |
| bootstrap | `make bootstrap` | 0 | `02-bootstrap.log` |
| models без подтверждения | `make models` | 2 (ожидаемо: требует `CONFIRM=1`) | `03-models-noconfirm.log` |
| models | `CONFIRM=1 make models` (`OLLAMA_EXTRA_CA_BUNDLE` для прокси песочницы) | 0 | `04-models.log` |
| ingest | `make ingest` | 2 (partial: Overpass 504 на 3 группах; база не деактивирована) | `05-ingest.log` |
| ingest повтор групп | `make ingest ARGS="--retry-failed osm-20261018T223058Z"` | 0 (complete) | `06-ingest-retry-failed.log` |
| index | `make index` | 0 (126 embedded) | `07-index.log` |
| up | `make up` | 0 (db, ollama, api, web healthy) | `08-up.log`, `12-up-final.log` |
| readiness | `curl /api/ready` | ready=true; db/data/map/embeddings/llm ok, routing not_configured | `09-ready.txt` |
| verify (ca1d8ac) | `make verify` | 0 (11/11 шагов) | `10-verify.log`, `verify/` |
| live-smoke №1 (ca1d8ac) | `make smoke-live` | 1 — FAIL из-за среды (старые процессы на тестовых портах), разбор в `smoke-run1-failed/ROOT_CAUSE.md` | `11-smoke-live.log` |
| live-smoke (db7c04f) | `SMARTCITY_LIVE_DEGRADED_WEB_URL=… make smoke-live` | 0 | `13-smoke-live-final.log`, `smoke-final/` |
| verify (db7c04f) | `make verify` | 0 (11/11) | `14-verify-final.log`, `verify-final/` |
| backup-test | `make backup-test` | 0 (counts + checksums равны) | `15-backup-test.log` |
| eval (db7c04f) | `make eval` | 0 (0 нарушений; 14/15 генераций live_rag, 1 честная деградация) | `16-eval.log`, `eval/` |
| verify + live-smoke (d7c9821) | `make verify`, `make smoke-live` | 0 / 0 | `final-gate/` |
| live-smoke (c468832) | `make smoke-live` | 1 — FAIL: S1 деградировал (все тексты модели отклонены дважды) → исправлено в ba066fe | `final-gate-2/ROOT_CAUSE.md` |
| verify (ba066fe) | `make verify` | 0 (11/11) | `final-gate-3/02-verify.log`, `final-gate-3/verify/` |
| live-smoke (ba066fe) | `SMARTCITY_LIVE_DEGRADED_WEB_URL=… make smoke-live` | 0 | `final-gate-3/03-smoke-live.log`, `final-gate-3/smoke/` |
| **итог: live-smoke (9eade71)** | `SMARTCITY_LIVE_DEGRADED_WEB_URL=… make smoke-live` | **0** | `artifacts/clean-install/20261019-final/03-smoke-live.log`, `20261019-final/smoke/` |
| **итог: verify (9eade71)** | `make verify` | **0 (11/11)** | `20261019-final/04-verify-9eade71.log`, `20261019-final/verify/` |

### Итоговый gate 9eade71 (после ba066fe)
Изменения после ba066fe: исправлен CI (дубль `CREATE DATABASE`, Python 3.13 в CI для стабильного OpenAPI),
maplibre-gl 5.24.0 → **6.15.0** (закрывает GHSA-jrc7-96c5-q579; regression-тест `tests/unit/maplibreVersion.test.ts`
проверяет версию ≥ 6.4.1 и совпадение раздаваемого worker), потоковый `POST /api/recommend/stream` (найденные места
показываются до ответа ИИ и остаются при его таймауте), ограниченные по времени проверки `/api/ready`,
`OLLAMA_KEEP_ALIVE=30m`, порядок наложения маркеров. Тот же чистый клон и датасет `osm-20261018T223058Z` (126 мест).

`make verify` (9eade71): py-test-api **161 passed**, py-test-ingest **43 passed** (0 skipped), web-unit **123 passed**,
web-e2e **42 passed / 3 skipped** (скриншот-утилита), lint/format/typecheck/build/secret-scan/contracts-sync — 0.
Live-smoke (9eade71): pytest live **3 passed** (S1, S2 + relaxation, S3), Playwright live **24 passed / 2 skipped**
(привязка к вьюпорту). Скриншот `desktop-1440-09-S1-places-before-ai.png` — карточки до ответа ИИ.
**Оговорка:** перед этим прогоном модель была прогрета одним коротким запросом вручную, т. е. измерено установившееся
состояние, а не холодный старт (холодная загрузка qwen2.5:3b ≈ 35 с; при таймауте карточки сохраняются — проверено
E2E и наблюдалось вживую на промежуточном прогоне).
CI GitHub Actions на ветке зелёный начиная с `0b5b14a` (run #17); статусы на итоговом commit — в описании PR.

`make verify` (ba066fe): py-lint 0, py-format 0, py-test-api **155 passed**, py-test-ingest **43 passed** (0 skipped,
`SMARTCITY_REQUIRE_DB=1`), web-lint 0, web-typecheck 0, web-unit **112 passed**, web-build 0, web-e2e **38 passed /
3 skipped** (скриншот-утилита под `SCREENSHOTS=1`, не проверка), secret-scan 0, contracts-sync 0.
Live-smoke (ba066fe): pytest live **3 passed** (S1, S2 + relaxation, S3 — все `live_rag`; smoke падает при skip),
Playwright live **24 passed / 2 skipped** (тесты привязаны к другому вьюпорту, где выполнены).

## Функциональные требования A01–A20

| Requirement | Status | Тест / команда | Среда / provider / dataset / commit | Exit | Доказательство |
|---|---|---|---|---|---|
| A01 чистая установка по README | PASS | Последовательность README в чистом клоне: doctor → bootstrap → `CONFIRM=1 make models` → ingest → index → up. Найдены и исправлены по ходу: отсутствовала БД `smartcity_test_ingest`, `make ingest` индексировал до запуска Ollama, `make models` не проверял результат (коммиты 4ade6d8…ca1d8ac). Особенность песочницы (TLS-прокси на loopback) документирована в README (`COMPOSE_FILE`/`BUILD_CA_BUNDLE`, `OLLAMA_EXTRA_CA_BUNDLE`) | чистый клон, ba066fe | 0 | `artifacts/clean-install/20261018/01…12` |
| A02 реальный ingest + manifest | PASS | `make ingest` + `--retry-failed` → complete; manifest: endpoint, запросы, полигон, дата, osm_base_timestamp, ODbL, counts, sha256 | LIVE Overpass maps.mail.ru, osm-20261018T223058Z | 0 | `clean-install/20261018/manifests/dataset_manifest.json`, `06-ingest-retry-failed.log` |
| A03 идемпотентность, изменение записи, partial не стирает | PASS | DET T19–T21, `test_idempotent_reimport`, изменение content_hash → переиндексация одной записи; LIVE: повторный import снимка → 0 изменений; partial-прогон (`05-ingest.log`) → `deactivated 0`, «snapshot not complete» | DET + LIVE | 0 | `final-gate-3/verify/py-test-ingest.log`, `05-ingest.log`, `artifacts/ingest/` |
| A04 ≥5 ориентиров по OSM ID | PASS | `data/manifests/landmarks.json` из снимка + `tests/security/landmarks_check.py` (QA) + PostGIS-расчёты ревьюера: Alem.ai/сфера way/454857501, EXPO way/454853233, квартал ЭКСПО-2017 way/1456208623, Mega Silk Way way/499328514, Ботанический сад way/1196402246, Назарбаев Университет way/424894683; MEGA→сфера 613 м, азимут 88°; Ботсад севернее (0.8°, 1876 м) | LIVE снимок | 0 | `data/manifests/landmarks.json`, `artifacts/qa/a04-landmarks-check.json` |
| A05 3D-контуры, height_source, 2D/3D, pan/zoom/rotate, маркеры | PASS | `map.live.spec.ts` ×3 вьюпорта: источники с features (1812 зданий), слой `fill-extrusion`, 2D↔3D, север, зум; высоты 23 height / 897 levels / 892 default (легенда «приблизительно») | LIVE | 0 | `final-gate-3/smoke/map-*.json`, `final-gate-3/smoke/screenshots/*-01-initial-3d-map.png`, `*-02-2d-map.png` |
| A06 ручной origin, GPS по запросу, отказ, вне покрытия | PASS | live: выбор кликом, отказ геолокации (контекст без разрешения) не блокирует, клик вне полигона отклонён с объяснением; API `outside_coverage` | LIVE | 0 | `final-gate-3/smoke/screenshots/*-03-outside-coverage-click.png`, `*-04-geolocation-denied.png` |
| A07 реальные embeddings + semantic+geo | PASS | API-лог `semantic: ok`, `llm_candidate_ids`; ready: bge-m3 dim 1024, 126/126 актуальных; DET T17/T18 | LIVE | 0 | `final-gate-3/smoke/ready.json`, `final-gate-3/smoke/responses/` |
| A08 настоящий LLM на реальной базе, transcript | PASS | `pytest -m live` (RUN_LIVE=1): S1, S2 relaxed, S3 — `mode=live_rag`, provider/model/digest, dataset, retrieved IDs | LIVE qwen2.5:3b, osm-20261018T223058Z, ba066fe | 0 | `final-gate-3/smoke/pytest-live.log`, `final-gate-3/smoke/api-transcripts/S1.json`, `S2.json`, `S2_relaxed.json`, `S3.json` |
| A09 факты из БД, ID карточек = маркеров, неизвестный ID отклонён | PASS | live `expectCardsMatchMarkers`; `tests/security/fact_check.py` (QA: 23 рекомендации, 0 расхождений); DET T14, T30 | LIVE + DET | 0 | `artifacts/qa/fact-check-*.json`, `final-gate-3/verify/py-test-api.log` |
| A10 S1–S3, честный no_match, полезный ответ | PASS | live: S1 3 альтернативы (бюджет ≤ 40), S2 «розетка обязательно» → no_match + relaxation → кафе с «Наличие розеток не подтверждено», S3 детские площадки с возвратом | LIVE | 0 | `final-gate-3/smoke/screenshots/desktop-1440-10…30*.png` |
| A11 бюджет каждой альтернативы, «по прямой» | PASS | `checkInvariants` в каждом live-ответе (сумма, буфер max(5,⌈10%⌉), return при return_to_start); `distance.method=geodesic`, «Время приблизительное»; DET T07/T08 | LIVE + DET | 0 | `final-gate-3/smoke/responses/`, `final-gate-3/verify/py-test-api.log` |
| A12 часы в Asia/Almaty, unknown ≠ open, окно start_time | PASS | DET T09–T12, «10:00+»→unknown, PH/SH→unknown; live: unknown → «Часы не указаны»; start_time вне [now−10 мин, now+7 дн] → 422; UI «Начало: указать время» | DET + LIVE | 0 | `final-gate-3/smoke/screenshots/desktop-1440-11-unknown-hours-card.png` |
| A13 уточнения сохраняют hard, гонки | PASS | live S1: «Поближе», «Без кафе», «Только внутри» меняют выдачу и сохраняют прежние hard-условия; отмена → новый запрос побеждает; DET T24 (поздний ответ не перезаписывает) | LIVE + DET | 0 | `final-gate-3/smoke/responses/`, `final-gate-3/smoke/cancel-stale.json` |
| A14 реальный датасет, source/updated/unknown видны | PASS | 126 реальных мест (66 безымянных площадок с пометкой «без названия в OSM»), 0 fake; карточка: источник OSM-ссылка, «Данные на …», неизвестные признаки | LIVE | 0 | `docs/DATA.md`, screenshots S1 |
| A15 no-WebGL fallback, mobile, keyboard, состояния | PASS (fallback — DET) | DET e2e «WebGL unavailable → SVG fallback + список»; live mobile 390/360 (bottom sheet, Карта/Список), Tab-порядок, axe без serious/critical (5 страниц), прогресс/отмена, no_match, offline/API down (DET) | DET + LIVE | 0 | `final-gate-3/verify/web-e2e.log`, `final-gate-3/smoke/axe-*.json`, `keyboard-tab-order-*.json` |
| A16 rate limit, validation, timeouts, secret scan, XSS/SSRF/PI, логи | PASS | probe QA (85 проверок); после исправлений: XFF подменить нельзя (preload + last hop), 413 и для тел без Content-Length, /docs выключен, access log выключен; live XSS/инъекция; secret-scan 0; pip-audit 0 уязвимостей после обновления; pnpm audit: 1 critical maplibre — недостижим, принят как R1 (docs/SECURITY.md) | DET + LIVE + LIVE-FAIL | 0 | `artifacts/qa/security/`, `final-gate-3/smoke/screenshots/desktop-1440-40-xss-injection.png`, `docs/SECURITY.md` |
| A17 все тесты на финальном commit, без скрытых skip | PASS | `make verify` 11/11 exit 0, `SMARTCITY_REQUIRE_DB=1` (skip БД-тестов = fail); live-smoke падает при skip pytest | чистый клон ba066fe | 0 | `final-gate-3/02-verify.log`, `final-gate-3/03-smoke-live.log` |
| A18 независимый reviewer + перепроверка QA | PASS | Ревью №1 (2 P1, 9 P2) → исправления → ревью №2 подтвердило закрытие P1/P2 и нашло регрессию N-1 (P2) → исправлено с тестом (db7c04f); QA-находки (2 P1, 8 P2) исправлены и перепроверены финальным gate и live-smoke | — | — | `docs/QA_REPORT.md`, раздел «Ревью» в `docs/FINAL_REPORT.md` |
| A19 README/env/bootstrap/backup/restore/privacy/licenses/demo | PASS | README-последовательность выполнена; `.env.example` без секретов; `make backup-test` PASS; restore в новую БД; docs/PRIVACY.md, LICENSES.md, DEMO.md, deployment.md, SECURITY.md | чистый клон | 0 | `15-backup-test.log` |
| A20 каждый видимый контрол работает | PASS | live: 2D/3D, север, +/−, «Показать результаты», карточка↔маркер, Поближе/Без кафе/Только внутри, relaxation, «Начать заново», «Отменить», геолокация, поиск, демо-точка, Карта/Список, «О данных»; «Другие варианты», «Изменить запрос», «Начало: указать время» — DET | LIVE + DET | 0 | `final-gate-3/smoke/playwright-live.log`, `final-gate-3/verify/web-e2e.log` |

## Edge cases T01–T30

Все DET-тесты входят в `make verify` (ba066fe, exit 0). Поимённый список: `final-gate-3/verify/py-test-api.log`,
`final-gate-3/verify/py-test-ingest.log`, `final-gate-3/verify/web-unit.log`, `final-gate-3/verify/web-e2e.log`.

| ID | DET | LIVE |
|---|---|---|
| T01 пустой/длинный/Unicode запрос | PASS `test_T01_*` | PASS (probe V07/X05/X06) |
| T02 NaN/невалидные координаты | PASS `test_T02_*` | PASS (probe V01–V03, V21–V23) |
| T03 вне покрытия | PASS `test_T03_*` | PASS (клик вне полигона) |
| T04 нет кандидатов | PASS `test_T04_*` (честное «бюджета не хватает») | PASS (eval D07/H08) |
| T05 hard socket при unknown → исключить | PASS | PASS (S2 no_match) |
| T06 пожелание socket при unknown не заявляется | PASS | PASS (S2 relaxed) |
| T07 точная граница бюджета и буфер | PASS | PASS (invariants) |
| T08 возврат и асимметричные плечи | PASS | PASS (симметрично; роутера нет) |
| T09 закрытие до прибытия | PASS | PASS (`wanted_category_closed`, eval ночью) |
| T10 закрытие во время визита | PASS | NOT_RUN |
| T11 неизвестные часы | PASS | PASS |
| T12 часы после полуночи | PASS | NOT_RUN |
| T13 невалидный JSON LLM | PASS | PASS (логи: retry → live_rag/retrieval_only) |
| T14 неизвестный place_id | PASS | PASS |
| T15 prompt injection в описании | PASS | PASS (eval D10, live инъекция) |
| T16 таймаут/429 LLM, занятость | PASS (+ `test_concurrency`, `llm_busy`) | PASS (LIVE-FAIL) |
| T17 embeddings недоступны | PASS | PASS (LIVE-FAIL: `embeddings_unavailable`) |
| T18 смена модели/размерности | PASS | NOT_RUN |
| T19 дубликат node/way | PASS | PASS (MEGA: node → alias way, 1 активная запись) |
| T20 частичный сбой ingest | PASS | PASS (`05-ingest.log`: partial, deactivated 0) |
| T21 удаление после полного снимка | PASS | NOT_RUN |
| T22 порядок координат, дырки | PASS | PASS (12 зданий с внутренними кольцами, landmarks [lon,lat]) |
| T23 нет роутинга → нет линии | PASS | PASS (`route=null`, `/api/route` 501) |
| T24 устаревший ответ | PASS (unit + e2e) | PASS частично (отмена; поздний ответ live не воспроизводим) |
| T25 XSS | PASS | PASS |
| T26 SSRF / произвольный URL | PASS | PASS (probe P/W) |
| T27 отрицательная длительность | PASS | PASS (422) |
| T28 unknown дети/доступность | PASS | PASS («Подходит ли детям — не подтверждено») |
| T29 дубли рекомендаций | PASS | PASS (invariants) |
| T30 LLM не переписывает факты | PASS | PASS (fact_check) |

## Качество и производительность

| Метрика | Значение | Метод / среда | Доказательство |
|---|---|---|---|
| Eval 20 запросов (10 dev + 10 holdout) | основной стек (prompt rec-v2): 0 нарушений; 15/15 генераций `live_rag`. Чистый стек (db7c04f): 0 нарушений; 14/15 `live_rag`, 1 деградация (H10). Оба раза 2 промаха ожиданий D04/D08 ночью (кафе закрыты/не помещаются в бюджет) → добавлены предупреждения `wanted_category_*` | `make eval` | `artifacts/eval/20261018T221419Z/`, `clean-install/20261018/16-eval.log` |
| Загрузка страницы / map-ready | cold map-ready 935 мс; warm 849–938 мс (ba066fe) | Playwright Chromium headless, тот же хост | `final-gate-3/smoke/perf-page-load.json` |
| API чтение p95 | < 16 мс (`/api/search`, `/api/places`, `/api/map/buildings`) | QA, последовательные запросы | `artifacts/qa/perf/` |
| `/api/recommend` с генерацией | eval: 23–89 с (p50 ≈ 55 с); без генерации (no_match, уточнение) < 1 с | CPU 4 vCPU, qwen2.5:3b, 1 запрос за раз | `artifacts/eval/*/results.json` |
| Память | см. `docker stats` в QA | QA | `artifacts/qa/perf/` |

## Повтор на финальном commit
Итоговый gate выполнен на `9eade71` (см. сводку выше; ранее — на `ba066fe`). Последующие коммиты — только документы
и артефакты. Строки A01–A20 ниже ссылаются на `final-gate-3/` (ba066fe); на 9eade71 они повторно подтверждены тем же
`make verify` + `make smoke-live` (`20261019-final/`). Риск R1 (maplibre) закрыт обновлением, `pnpm audit` — 0.
