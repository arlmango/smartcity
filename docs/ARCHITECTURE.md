# Архитектура и контракты

## Выбранный стек
- Frontend: TypeScript, React/Next.js App Router, Tailwind CSS, MapLibre GL JS; Zod для контрактов, TanStack Query для запросов, простое состояние без тяжёлого глобального фреймворка.
- Backend: Python/FastAPI/Pydantic, SQLAlchemy + Alembic, HTTPX, pytest. GeoJSON/Shapely для геометрии и ingest.
- Database: PostgreSQL + PostGIS + pgvector. Выбери поддерживаемый образ с обеими extensions или воспроизводимый Dockerfile; зафиксируй версии. Один PostgreSQL достаточно, Redis не обязателен: кеш на сервере/БД с TTL.
- AI: GenerationProvider и EmbeddingProvider. Локальный Ollama как бесплатный по лицензии ПО вариант, либо реально доступный OpenAI-compatible сервер через конфигурацию пользователя. Не считать все такие API идентичными: контрактный тест и adapter capabilities обязательны. Не требовать один конкретный коммерческий аккаунт.
- Tests: pytest, Vitest/Testing Library, Playwright, axe-core; CI без платных сервисов. Test fixtures изолированы от live-smoke.
- Containerization: Compose web/api/db; optional profile ollama; optional routing Valhalla. Запуск не должен молча скачивать огромные модели или весь Казахстан.

Версии подобрать по текущим официальным документам и совместимости, не «latest» в финальной конфигурации. Это решение по умолчанию; если уже есть хороший эквивалентный стек, не переписывать проект ради формального совпадения. Обоснование отклонений в ADR.

## AI без ложной автономности
До загрузок проверь RAM, disk, CPU/GPU, сетевые ограничения и время жизни среды. Запиши оценку диска/памяти модели и размер скачивания. Маленькая локальная instruct-модель допустима, если проходит русскоязычный evaluation; небольшой multilingual embedding model должен пройти релевантность. Не обещай быстрый CPU inference. Если среда не тянет local, используй только уже предоставленный/разрешённый endpoint и secret env; не создавай аккаунты, ключи или подписки сам.

Обязательное подтверждение RAG = реальная генерация + реальные embeddings + retrieval на реальном датасете. Без этого проект может быть CODE_READY_AI_BLOCKED, но не DONE. Отсутствие optional routing/key для платного basemap не блокирует обязательный честный MVP: карта использует локальную геометрию; расстояния помечены approximate.

Для модели сохранить provider, model_name, revision/digest где доступен, параметры, timeout и фактически использованную размерность embeddings. Изменение embedder инвалидирует индекс и требует reindex. Размерность устанавливается миграцией/конфигурируемой коллекцией после реального probe, не предполагается одинаковой. Тест вычисляет query/document vectors совместимым preprocessing.

## Структура, которую нужно создать
apps/web/ — UI и client integration
services/api/ — endpoints, domain, providers, retrieval, validation
services/ingest/ — extract, normalize, deduplicate, import, indexing; `basemap` — тайлы города (vtiles.py, roofs.py)
packages/contracts/ — JSON Schema/OpenAPI snapshots и generated client
infra/ — Dockerfiles, Compose, deployment templates
scripts/ — bootstrap, ingest, index, verify, live-smoke
data/manifests/ — provenance и статистика без персональных данных
data/snapshots/ — только допустимый реальный ограниченный снимок и лицензия
models/ — не коммитить бинарные веса
tests/fixtures/ — явно синтетические данные
docs/ — отчёты, источники, ограничения, руководство
artifacts/ — тестовые отчёты и screenshots, без секретов

## Data model
places:
- id UUID, source text, source_type node|way|relation, source_id bigint; unique(source,source_type,source_id).
- name text NOT NULL, names jsonb; geom geometry(Geometry,4326), location geography(Point,4326), bbox.
- category enum/normalized text; tags jsonb, description text, address jsonb.
- opening_hours_raw text nullable; timezone 'Asia/Almaty'; website nullable.
- amenities jsonb: свойство → {value: true|false|null, evidence_ids: [...]}.
- active bool, content_hash text, fetched_at timestamptz, source_updated_at nullable.
place_evidence:
- id, place_id, field, source_url, source_license, collected_at, source_value; безопасный краткий фрагмент, не полный запрещённый контент.
place_embeddings:
- place_id, embedding, model_id, content_hash, created_at. Один активный согласованный индекс.
ingest_runs:
- run_id, source, bbox/polygon, started/finished, status, counts, error_summary, snapshot_hash. partial не может массово деактивировать данные.
coverage:
- id, geom Polygon/MultiPolygon, dataset_version, freshness, place_count.
map_features:
- стабильные ID, геометрия, слой, height_m, height_source, license, snapshot; можно хранить GeoJSON-файлами вне БД, не дублировать без причины.

PostGIS index для location/geom, pgvector index выбирается под фактический объём; маленькому dataset допустим точный vector scan. Не создавать HNSW ради галочки. Geo-фильтр, ограничения и evidence детерминированы.

## API v1
GET /api/health — процесс жив; без секретной конфигурации.
GET /api/ready — компоненты и пригодность: db,data,map,embeddings,llm,routing; routing optional.
GET /api/coverage — GeoJSON границ, версия, число записей, обновление.
GET /api/map/{layer} — ограниченная карта, ETag/cache, whitelist layer.
GET /api/tiles/{base|buildings}/{z}/{x}/{y} — векторные тайлы всей Астаны из локальных PMTiles (ADR-0002), ETag/304.
GET /api/basemap, /api/basemap/boundary — сводка базовой карты (лицензии, покрытие, высоты, спутник по режиму) и граница города.
GET /api/places?bbox=...&category=...&limit=... — bounded server filtering.
GET /api/places/{id} — данные/источники одного места.
GET /api/search?q=... — поиск своей базы, без дорогого внешнего геокодинга.
POST /api/recommend — основной запрос; idempotency/request correlation, cancellation где возможно.
POST /api/route — только если настоящий router включён; иначе структурированный routing_unavailable, не mock.

POST /api/recommend request (схема уточняется и фиксируется до параллельной работы):
{
  "origin": {"lat":51.09,"lon":71.414},
  "query":"Хочу кофе и немного прогуляться",
  "time_budget_min":50,
  "return_to_start":true,
  "travel_mode":"walking",
  "constraints":{"hard":[],"preferences":[]},
  "conversation_context":[],
  "client_request_id":"random-id"
}
Координаты выше только пример формата, не адрес конкретного заведения. Проверять ranges, покрытие, объём текста/контекста, числа finite.

Response:
{
  "request_id":"...", "status":"ok|no_match|needs_clarification|degraded",
  "mode":"live_rag|retrieval_only", "dataset_version":"...",
  "constraints_applied":{}, "recommendations":[{
    "place_id":"...", "name":"из БД", "coordinates":{},
    "reason":"grounded", "activity_suggestion":"оценка",
    "distance":{"meters":0,"method":"pedestrian_route|geodesic"},
    "timing":{"outbound_min":0,"visit_min":0,"return_min":0,"buffer_min":0,"total_min":0,"estimated":true},
    "opening_status":"open|closed|unknown", "as_of":"...",
    "verified_features":[], "unknown_features":[], "evidence":[]
  }], "warnings":[], "suggested_relaxations":[], "route":null
}
Не показывать нулевые placeholder значения реальным пользователям: null/unknown или отсутствие поля, если не рассчитано. route GeoJSON содержит геометрию только настоящего маршрута и metadata провайдера. Проверка budget производится сервером. LLM не может переписать фактическое имя, URL, часы или координаты.

## Retrieval и ранжирование
Предварительная разумная географическая область из бюджета с запасом, затем distance sort + категории, sparse lexical score + embedding cosine. Метод объединения (например RRF) документируется; проверить на отложенных запросах. Обязательные фильтры применяются до и после ranking. Для 1–3 разнообразных вариантов не выдавать одинаковое место дважды. Не скрывать провал hard constraint высоким semantic score.

LLM извлекает структурированные условия с валидацией; simple controls остаются source of truth. Generation получает список candidate IDs/evidence и возвращает JSON по строгой схеме. Нельзя давать LLM право выполнять SQL или произвольные URL. Token budgets и bounded retries. Не обучать модель на пользовательских запросах.

## Cache и ошибки
Map/data cache по dataset_version. Embeddings cache по model+content_hash. Routing cache по подходящему округлению и профилю/версии; не делать точные координаты долгоживущей историей. Приватный request-scoped ответ, исключить утечку чата между пользователями. Таймауты и cancellation, explicit 429/503, UI retry без дубликатов. Circuit breaker при повторяющемся отказе внешнего источника.


## Local pedestrian pilot (19 October 2026)

The optional `valhalla` provider currently accepts loopback HTTP only, with environment proxies disabled.
It uses the bounded Astana graph (OSM 18 October), pedestrian costing at 4 km/h and separate A→B→A legs.
Recommendation candidates are routed **before** hard budget, opening-hours checks, ranking and RAG.
Timing uses each leg's rounded duration plus estimated approach to/from the snapped network endpoint;
no factor-of-two return or straight-line detour multiplier is applied to routed time.
The UI's explicitly geodesic distance constraint retains a separate original distance.

`Recommendation.route` contains provider, graph version, note, outbound and optional return leg;
each leg has GeoJSON LineString, distance/duration, snap gaps and estimated access minutes.
Top-level legacy `route` remains null. No route is invented by the model or UI.
Candidates with no path/out-of-pilot geometry/snap >100m are excluded. Transport failure or the
8-second/256-call stage limit discards all partial routes and returns explicit geodesic estimates.
The pilot has a network-geometry audit, not physical entrance/access verification. Default provider is none.
For measured controls, runtime ports, resources and reproducible build, see `artifacts/routing-pilot/STATUS.md`.
