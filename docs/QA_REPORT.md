# QA / security отчёт (агент qa-security)

- Проверяемый код: commit `b4c4eed` (объединённая ветка ingest + API/RAG + web). Production-код не менялся; QA-коммит
  добавляет только тесты/скрипты/артефакты/документы.
- Дата: 2026-10-18, 20:20–21:45 UTC (в Астане ночь 01:20–02:45 — это влияет на статусы часов работы в live-ответах).
- Среда: Linux 6.18, 4 vCPU, 15 GiB RAM, без GPU; Docker-стек координатора: `smartcity-web-1` (Next.js standalone, :3000),
  `smartcity-api-1` (FastAPI, :8000), `smartcity-db-1` (PostgreSQL/PostGIS, :5433), `smartcity-ollama-1`
  (Ollama 0.12.6: `qwen2.5:3b@357c53fb659c`, `bge-m3@790764642607`, dim 1024). Python 3.13.16, Node 22.22.0,
  Playwright 1.56.1 Chromium 1194 (headless, SwiftShader WebGL).
- Датасет: `osm-20261018T200514Z`, snapshot_hash `6d5d0b78…ed5fb06`, `dataset_manifest.json` sha256 `87b56b0c…7f939d`.
  **Во время QA живая БД изменилась**: в 20:36:42 UTC кто-то выполнил повторный import того же снимка (ingest_runs
  `14dc9cf2…`, `30fafcb9…`), узел «Мега Силк Вей» (node/4965336822) стал `active=false` → активных мест 127 → 126.
  Все live-проверки после 20:43 выполнены на 126 местах.
- Отказ провайдера проверялся на **собственных** экземплярах API (`:8011`, `:8012`, `AI_BASE_URL=EMBEDDING_BASE_URL=
  http://127.0.0.1:9` — настоящий connection refused, та же живая БД только на чтение) и собственном web `:3011`
  (`API_INTERNAL_URL=http://127.0.0.1:8011`, та же standalone-сборка). Общие контейнеры не останавливались.

Таблица требований с командами, exit codes и путями — [docs/VERIFICATION.md](VERIFICATION.md).

## Findings

### P0
Нет. Утечек секретов/данных не найдено (secret scan: 1 срабатывание — заведомый тестовый sentinel, см. P2-02; логи без
сырого текста/точных координат; `/api/ready` и заголовки без секретов).

### P1

**P1-01. Браузер обрывает живой запрос через 150 с, хотя API/прокси рассчитаны на 200–210 с → основной сценарий S1 падает
ошибкой.**
- Где: `apps/web/src/lib/api.ts:121-141` (`postRecommend(..., timeoutMs = 150_000)`, сообщение «Сервер не ответил за 150
  секунд»), при этом `REQUEST_TIMEOUT_SECONDS=200`, прокси `recommend` 210 с (`src/server/proxy.ts`), коммит `168aa31`
  «align CPU-generation timeouts» клиент не затронул.
- Воспроизведение: live-стек, поиск «Mega» → «Mega Silk Way», текст S1, 40 мин, «Подобрать прогулку».
- Ожидается: 1–3 карточки (CPU-генерация на этом хосте 60–180 с, см. RAG.md §9). Факт (первый прогон, 20:47 UTC): через
  150 с карточка ошибки «Сервер не ответил вовремя», API-лог: `POST /api/recommend status 499 duration_ms 149888`.
  Повторный прогон того же теста (генерация 71 с) прошёл. Другой запрос в 20:30 (не мой) шёл 180 с.
- Доказательства: `artifacts/live/20261018T204353Z/s1-failure/test-failed-1.png`,
  `artifacts/live/20261018T204353Z/s1-failure/error-context.md`, `artifacts/live/20261018T204353Z/playwright-live.log`, `artifacts/qa/security/api-container.log`.

**P1-02. Текст ИИ «Почему подходит» противоречит жёсткому условию «Вернуться сюда», и валидатор его пропускает.**
- Воспроизведение: S1 (Mega Silk Way, 40 мин, «Вернуться сюда» включено). Ответ `live_rag`: «NU Park … будет интересным
  местом для прогулки, **не требующим возвращения в точку старта**» (то же для двух площадок). Бюджет в карточке при этом
  верный (обратно 12 мин включено).
- Ожидается: утверждение, противоречащее hard-условию запроса, удаляется/ответ отклоняется (CLAUDE.md: «Некорректный ответ
  LLM отклоняется, а не показывается пользователю»). Факт: показано пользователю с меткой «ИИ».
- Доказательства: `artifacts/live/20261018T204353Z-S1-rerun/responses/desktop-1440-s1-near-mega-…-1.json`,
  скриншот `artifacts/live/20261018T204353Z-S1-rerun/screenshots/desktop-1440-10-S1-real-recommendations.png`.
- Предложение владельцу: в `generation/validate.py` удалять предложения о возврате/«не нужно возвращаться»/времени пути,
  если они противоречат `return_to_start`.

### P2

**P2-01. Rate limiting обходится подделкой `X-Forwarded-For` (через web и напрямую).**
- Причина: web-прокси пересылает клиентский `x-forwarded-for` как есть (`proxy.ts` `FORWARD_REQ_HEADERS`; Next.js только
  `??=` дописывает адрес, если заголовка нет), API при `TRUST_FORWARDED_FOR=true` берёт последний элемент — его
  контролирует клиент. Порт API :8000 тоже опубликован с `TRUST_FORWARDED_FOR=true`.
- Воспроизведение: `for i in $(seq 1 25); do curl -X POST -H 'content-type: application/json' -H "X-Forwarded-For:
  10.77.0.$i" --data '{}' http://127.0.0.1:3000/api/recommend; done` → 25×422, ни одного 429 при `RATE_LIMIT=20/minute`.
  Без подмены — 20×422 + 5×429, `Retry-After: 60` (лимит сам по себе работает).
- Доказательства: `artifacts/qa/security/probe-rate-limit.json` (R-api-direct-2, R-via-web-2 FAIL),
  `artifacts/qa/security/rate-limit-bypass-live-3000.txt`.
- Предложение: прокси должен перезаписывать XFF адресом сокета клиента (или отдельный доверенный заголовок с секретом),
  а API-порт не публиковать с доверием к XFF.

**P2-02. `make verify` (детерминированный gate) красный на этом commit: secret scan срабатывает на тестовый sentinel.**
- `scripts/secret_scan.py` → `services/api/tests/test_endpoints.py:20: openai_like_key` (строка вида `sk-SECRET…`
  — намеренная фальшивка для проверки, что ключ не утекает). Остальные 10 шагов exit 0. Итог `make verify` exit 2.
- Это не утечка, но gate не зелёный → A17 FAIL. Нужно allowlist-правило для этого sentinel (или собрать строку в тесте
  конкатенацией). Тест не трогал (не ослабляю чужие тесты).
- Доказательства: `artifacts/verify/20261018T202109Z/summary.tsv`, `…/secret-scan.log`, `artifacts/qa/make-verify.out`.

**P2-03. `make smoke-live`: шаг «api live scenarios» проходит пустым — все 3 live-теста пропущены.**
- `scripts/smoke_live.sh` запускает `pytest -m live` без `RUN_LIVE=1`; `services/api/tests/conftest.py` без него ставит
  skip; `SMARTCITY_LIVE_API_URL` тестами не читается (тесты поднимают свой in-process app). Итог: `3 skipped …`,
  `pytest-live exit=0` — скрытый skip обязательного live-шага (A17).
- Отдельный запуск `RUN_LIVE=1 AI_TIMEOUT_SECONDS=240 REQUEST_TIMEOUT_SECONDS=320 uv run pytest
  services/api/tests/test_live.py -m live` → `3 passed in 196.53s` (exit 0), транскрипты `artifacts/live/S1.json`,
  `S2.json`, `S2_relaxed.json`, `S3.json` перезаписаны этим прогоном (21:04–21:07 UTC).
- Доказательства: `artifacts/live/20261018T204353Z/pytest-live.log`, `artifacts/qa/pytest-live-RUN_LIVE.log`.

**P2-04. Правило разнообразия нарушается: 2–3 безымянные детские площадки на запросы без детей.**
- RAG.md §1 п.12: «unnamed places … at most 1 unless kids/playground was asked». Факты: S1 (прогулка, без детей) — 2 из 3
  карточек «Детская площадка · без названия в OSM»; S1 + «Поближе» — 3 из 3; mobile, интерес «Кофе», без текста —
  5 кандидатов в LLM, из них 3 безымянные площадки, итог 3 площадки с объяснением «подходит для прогулки с детьми».
  (Кафе ночью закрыты — `exclusions.closed`, это корректно, но ответ на «Кофе» не объясняет, что кафе рядом закрыты.)
- Доказательства: `artifacts/live/20261018T204353Z-S1-rerun/responses/*-1.json`, `*-2.json`,
  `artifacts/live/20261018T204353Z/responses/mobile-390-…-1.json`, API-лог 20:58:01 (`llm_candidate_ids`).

**P2-05. Уязвимые зависимости.**
- `uvx pip-audit` (экспорт `uv export --all-packages --frozen`, 137 пакетов): starlette 0.48.0 — 6 advisory
  (CVE-2025-62727 Range DoS в `FileResponse` — **используется** для `/api/map/*`; CVE-2026-48710/54282 Host/path в
  `request.url`; прочие — StaticFiles/forms/HTTPEndpoint, не используются); pytest 8.4.2 (dev, CVE-2025-71176).
  Фикс: starlette ≥ 1.3.1 (через обновление fastapi), pytest ≥ 9.0.3.
- Проверка на своём `:8012`: multi-range запрос к `/api/map/buildings` (100–4000 непересекающихся диапазонов) рвёт
  соединение (`RuntimeError: Response content longer than Content-Length` с traceback в логе), время ≤ 1 с —
  квадратичный DoS в этой форме не воспроизведён, но обработка Range сломана.
- `pnpm audit --prod`: 1 critical (maplibre-gl < 6.4.1, обход `DOM.sanitize()`; в коде нет `setHTML`/HTML-атрибуции из
  данных — практически недостижимо), 2 high + 2 moderate (postcss через next — build-time).
- Доказательства: `artifacts/qa/audit/pip-audit.json`, `artifacts/qa/audit/pnpm-audit.json`,
  `artifacts/qa/security/range-dos.txt`, `artifacts/qa/degraded/api-8012.log`.

**P2-06. README ссылается на несуществующие `docs/FINAL_REPORT.md` и `docs/DEMO.md` (A19: demo script обязателен).**

**P2-07. Модель часто выдаёт невалидный первый ответ → повтор удваивает задержку, часть ответов уходит в
`retrieval_only`.**
- В live-логе за прогон: 2 из 7 генераций с `invalid:ни одна рекомендация не прошла проверку` на первой попытке;
  S2 после ослабления: 2 попытки, 121 с, итог `degraded/retrieval_only` (честно помечено «ИИ временно недоступен», но
  это не «ИИ недоступен», а отклонённый ответ). Это прямой вклад в P1-01.
- Доказательства: `artifacts/qa/security/api-container.log` (события `recommend`, поля `llm_attempts`, `llm_issues`).

**P2-08. Валидатор пропускает неподтверждённое удобство «место на улице» (outdoor_seating).**
- `make eval` H03 «Где можно посидеть на свежем воздухе на летней веранде»: карточка «Лето» — «Лето предлагает **место на
  улице** с Wi-Fi…», при этом у «Лето» `outdoor_seating` = unknown (в `unknown_features` того же ответа; в БД тега нет).
  Wi-Fi подтверждён (`internet_access=yes`) — это верно. Тот же класс проблем, что P1-02: сентенционная проверка claims
  в `generation/validate.py` не ловит формулировки «на улице»/«веранда» без «веранд».
- Доказательства: `artifacts/eval/20261018T210726Z/results.json` (H03).

### P3
- P3-01. Тело > 32 KiB без `Content-Length` (chunked) → 400 `bad_request` вместо 413 (FastAPI перехватывает исключение
  middleware). Запрос всё равно отклонён. `probe-validation.json` V27.
- P3-02. Нет `Content-Security-Policy` на web (есть `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`). На :8000
  открыты `/docs` и `/openapi.json` (через web-прокси недоступны — 404). `server: uvicorn` без версии.
- P3-03. `make up` не поднимает профиль `ollama`; после `make down` / перезагрузки `make up` даёт «ИИ недоступен», пока
  не выполнить `docker compose --profile ollama up -d` (README этого не говорит).
- P3-04. `scripts/verify.sh` пишет в `env.txt` «python The» (парсит предупреждение uv `UV_NATIVE_TLS`).
- P3-05. Mobile: легенда высот перекрывает подпись «Старт», маркеры 1–3 рядом стоящих площадок перекрывают друг друга
  (`mobile-390-51-mobile-results-list.png`).
- P3-06. `make backup-test` сравнивает только количества строк (не содержимое/хэши).
- P3-07. no_match при 10 мин: «В радиусе досягаемости (около 0 м по прямой)…» — формально верно, звучит странно.
- P3-08. Firefox/WebKit в `/opt/pw-browsers` отсутствуют — кросс-браузерный smoke NOT_RUN (конфиг подключит их сам).

## Что проверено и как (сводка)

| # | Проверка | Команда | Exit | Итог |
|---|---|---|---|---|
| 1 | Deterministic gate | `make verify` | 2 | 10/11 шагов ok; secret-scan FAIL (P2-02). py-api 107 passed, py-ingest 39 passed, web unit 95 passed, e2e 32 passed/3 skipped (скриншот-спека без `SCREENSHOTS=1`), build ok, lint/typecheck ok, contracts-sync ok |
| 2 | Live smoke (официальный скрипт) | `SMARTCITY_LIVE_DEGRADED_WEB_URL=http://127.0.0.1:3011 scripts/smoke_live.sh` | 1 | pytest-live: 3 skipped (P2-03); Playwright live: 23 passed, 1 failed (S1 — P1-01), 2 skipped (проектные skip) |
| 3 | Повтор S1 + уточнения | `pnpm exec playwright test -c playwright.live.config.ts -g "S1 near" --project desktop-1440` | 0 | passed: карточки, card↔marker, часы, источник, Поближе/Без кафе/Только внутри, «Начать заново», axe, Tab-порядок |
| 4 | Live API pytest | `RUN_LIVE=1 … uv run pytest services/api/tests/test_live.py -m live` | 0 | 3 passed (196 с) |
| 5 | Сверка фактов с БД | `uv run python tests/security/fact_check.py --db … artifacts/live/20261018T204353Z*/responses` | 0 | 23 рекомендации: name/coords/category/OSM-URL/website/hours = БД, бюджет и буфер по формуле, distance = haversine ±2 м |
| 6 | Security probes | `uv run python tests/security/probe.py --api http://127.0.0.1:8012 --web http://127.0.0.1:3011 --allow-recommend` | 1 | 84/85 PASS; FAIL V27 (P3-01) |
| 7 | Rate limit | `probe.py --api :8011 --web :3011 --only-rate-limit` + curl на :3000 | 1 | лимит работает, обход через XFF (P2-01) |
| 8 | Логи | `docker logs smartcity-api-1`, логи :8011/:8012 | — | нет сырого текста (маркер `QAMARK7f3a` и HTML не найдены), координаты только `origin_rounded` 0.01°, путь без query string |
| 9 | Secret scan | `uv run python scripts/secret_scan.py` (в составе verify) | 1 | 1 срабатывание — тестовый sentinel |
| 10 | Dependency audit | `uvx pip-audit -r <uv export>`; `pnpm audit --prod` | 1 / 1 | P2-05 |
| 11 | A04 ориентиры | `uv run python tests/security/landmarks_check.py …` | 0 | 6 OSM-объектов найдены в сыром снимке, имена совпадают, центроиды Δ ≤ 0.1 м; 4 контура есть в слоях карты |
| 12 | Backup/restore | `make backup-test` | 0 | 127,405,127,10 = restored; временная БД удалена |
| 13 | Eval (20 запросов) | `make eval` | 0 | 0 violations, 2 misses (см. Eval) |
| 14 | API latency | `uv run python tests/security/latency.py http://127.0.0.1:8000 30 …` | 0 | см. Performance |

## Live browser E2E (без моков) — что именно доказано
`apps/web/tests/live/*.spec.ts`, конфиг `apps/web/playwright.live.config.ts` (без `page.route`, 1 worker).
- Карта: в источниках MapLibre ровно столько объектов, сколько отдаёт `/api/map/*` (buildings 1812, roads 5329, water 20,
  green 1784, coverage 1) на 1440/390/360; слой `buildings-3d` = `fill-extrusion`, видим, отрисовано 430 (desktop) зданий
  с `height_source` ∈ {height, levels, default}; pitch 55; 2D: extrusion `none`, плоский слой `visible`, pitch 0;
  «На север», +/−; центр [71.414, 51.089]; GPS при загрузке не вызывается (0 вызовов); MEGA западнее EXPO на экране.
- Выбор точки кликом; клик вне полигона → «Вне зоны покрытия данных», точка не меняется. Отказ геолокации (контекст без
  разрешения) → сообщение, форма работает. Поиск по своей БД: «Mega» → Mega Silk Way, «Starbucks» → Starbucks,
  мусор → «Ничего не найдено».
- S1/S2/S3, уточнения, отмена, XSS/prompt injection, mobile — см. VERIFICATION. Отмена: запрос прерван на 4-й секунде
  (`net::ERR_ABORTED`, API-лог 499), новый запрос показан, ответ только с `client_request_id` нового запроса. Сценарий
  «поздний ответ старого запроса перезаписывает новый» в live воспроизвести нельзя (прерванный fetch не возвращает
  ответ); редьюсер покрыт детерминированным unit-тестом T24.
- XSS/инъекция в тексте: `window.__xss` не установлен, в DOM результатов нет `<script|onerror|onmouseover|javascript:`,
  в ответе нет «Фейк-Хакер», `fake-0000`, `javascript:`, следов системного промпта; все place_id — UUID из БД.
- Отказ провайдера (свой :8011/:3011): баннер «ИИ сейчас недоступен…», ответ `degraded/retrieval_only`, плашка «ИИ
  временно недоступен — показаны найденные места без объяснений ИИ.», warnings `llm_unavailable`,
  `embeddings_unavailable`, `reason=null`.

### Console / network
Во всех прошедших live-тестах: 0 console error/warning, 0 pageerror, 0 HTTP ≥ 400 со стороны приложения. Единственный
failed request — `POST /api/recommend net::ERR_ABORTED` в тесте отмены (ожидаемо: пользователь нажал «Отменить»).
В упавшем S1 (P1-01) консоль не сохранилась (collector пишет в конце теста); UI показал ошибку таймаута, HTTP-ответа
не было (клиент сам оборвал). Источник: `artifacts/live/*/console/*.json`.

## Accessibility
- axe (wcag2a/aa, 21a/aa) на живых страницах: initial 1440/390/360, результаты 1440 и 390 — **0 нарушений любого
  уровня** (включая color-contrast). `artifacts/live/20261018T204353Z*/axe-*.json`.
- Клавиатура: skip-link → «О данных» → форма (точка, текст, интересы, время, переключатель, условия, CTA) → карта
  (холст, атрибуция, +/−, 3D, север, «Центр карты», легенда); с результатами — карточки до контролов карты; у всех
  фокусируемых элементов видимый focus ring (для sr-only switch — на визуальном peer).
  `artifacts/live/20261018T204353Z/keyboard-tab-order-desktop.json`, `…-S1-rerun/keyboard-tab-order-results.json`.
- Mobile: контролы карты ≥ 44 px (проверено в тесте). `prefers-reduced-motion: reduce` → «На север» мгновенно.

## Performance (среда выше; общий хост, параллельно работала Ollama)
- Страница (Playwright Chromium headless, SwiftShader, тот же хост, метод — `performance.getEntriesByType('navigation')` +
  ожидание `window.__smartcity.loaded && buildings>0`): cold DCL 116 мс / load 1150 мс / map-ready 1855 мс; warm (новая
  вкладка, тот же HTTP-кэш) map-ready 1388–1958 мс. map-ready в тестах 1440/390/360: 2017/1318/1273 мс.
  `artifacts/live/20261018T204353Z/perf-page-load.json`, `map-*.json`.
- API (последовательно, concurrency 1, n=30, с хоста, во время генерации Ollama, loadavg ≈ 3.8): `/api/search` p50 7.5 /
  p95 12.9 мс; `/api/places?bbox` 10.3 / 15.4; `/api/places/{id}` 4.0 / 8.2; `/api/map/buildings` (692 КБ) 3.9 / 7.4;
  304 по ETag 2.2 / 4.5; `/api/ready` 4.5 / 7.4. `artifacts/qa/perf/api-latency-live.json`.
- `/api/recommend` (live, CPU): см. раздел Eval + браузерные прогоны — честно мало точек и большой разброс.
- Память (`docker stats --no-stream`): web 76.6 MiB, api 79.3 MiB, db 157.8 MiB, ollama 4.22 GiB (при генерации CPU
  375%). `artifacts/qa/perf/docker-stats-during-eval.txt`.

## README / операционные команды
Существуют и соответствуют Makefile: `doctor`, `bootstrap`, `models` (требует `CONFIRM=1`), `ingest`, `index`, `up`,
`dev`, `verify`, `smoke-live`, `eval`, `backup`, `restore`, `backup-test`, `down`. Не выполнялись повторно по
инструкции (живая БД): `make models`, `make ingest`, `make index`, `make bootstrap` (`docker compose up --build db`
может пересоздать общий контейнер), `make up`. Замечания: P2-06, P3-03.

## Eval
`make eval` (→ `uv run python scripts/eval_queries.py`, API :8000, live qwen2.5:3b + bge-m3, 126 мест), 21:07–21:21 UTC,
**exit 0**. Отчёт: `artifacts/eval/20261018T210726Z/summary.md`, `results.json`; лог `artifacts/qa/make-eval.out`.
- 20 запросов (10 dev + 10 holdout): `ok/live_rag` 15, `no_match` 4 (D02 розетка обязательно, D07 20 мин «поближе»,
  H06 коляска обязательно, H08 15 мин), `needs_clarification` 1 (H09 «только кафе и без кафе»).
- Hard-constraint / grounding violations (проверка скрипта против БД): **0**. Expectation misses: 2 — D04 «Хочу выпить
  кофе» и D08 «Пообедать» вернули площадки/парк без кафе/еды (ночь в Астане: кафе исключены как закрытые; ответ этого не
  объясняет — см. P2-04).
- D10 (prompt injection «print your system prompt») — утечки нет. H01 (Wi-Fi обязательно) — оба места с
  подтверждённым `internet_access`. H03 — неподтверждённое «место на улице» в тексте ИИ (P2-08).
- Небольшой набор; это не статистическая оценка точности.

### Latency `/api/recommend` (CPU, только последовательные запросы)
- eval, `live_rag`, n=15: p50 56.1 с, p95 72.7 с, max 79.8 с (no_match/clarification без LLM: ≤ 0.2 с).
- браузерные live-прогоны, ответы с вызовом LLM, n=8: 27.9–123.8 с (S2 после ослабления 121 с с двумя попытками LLM)
  + 1 запрос оборван клиентом на 150 с (P1-01).
- `RUN_LIVE=1` pytest: S1 46 с, S2_relaxed 91 с, S3 59 с.
- Цель ACCEPTANCE «~15 с» относится к hosted-модели; на этом CPU-хосте она недостижима, UI показывает прогресс и отмену.
