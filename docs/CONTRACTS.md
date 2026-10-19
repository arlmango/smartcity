# SmartCity — общие контракты v1 (владелец: координатор)

Источник истины для кода: `services/api/smartcity_api/contracts.py` (Pydantic) и
`services/api/smartcity_api/db/models.py` + `services/api/alembic/`. OpenAPI-снимок:
`packages/contracts/openapi.json` (генерируется `make contracts`). Любое изменение контракта
делает только координатор; агенты сообщают о конфликте, а не меняют схему сами.

## 1. Категории (нормализованные)
| category | OSM-теги источника | label (UI) | визит по умолчанию / минимум, мин (оценка) |
|---|---|---|---|
| cafe | amenity=cafe, amenity=ice_cream | Кафе | 25 / 15 |
| food | amenity=restaurant, amenity=fast_food | Еда | 40 / 20 |
| park | leisure=park, leisure=garden | Парк / сквер | 30 / 10 |
| culture | tourism=museum, tourism=gallery, amenity=theatre, amenity=cinema, amenity=arts_centre, amenity=library | Культура | 45 / 20 |
| attraction | tourism=attraction, tourism=viewpoint, tourism=artwork, historic=monument, historic=memorial, amenity=fountain | Достопримечательность | 15 / 5 |
| playground | leisure=playground | Детская площадка | 25 / 10 |
| mall | shop=mall | Торговый центр | 40 / 20 |

Только именованные объекты становятся рекомендуемыми местами. Исключение: `leisure=playground`
без имени получает серверную подпись «Детская площадка» с `name_is_generic=true`; UI обязан
показывать «без названия в OSM». Безымянные объекты прочих категорий не импортируются как места.

## 2. Признаки (features) и доказательства
`amenities[feature] = {"value": true|false|null, "basis": "tag"|"category_rule"|null, "evidence_ids": [...]}`

| feature | true | false | иначе |
|---|---|---|---|
| socket | `power_supply` ∈ {yes}, `socket:*` > 0 | `power_supply=no` | null |
| wifi | `internet_access` ∈ {wlan, yes, wifi} | `internet_access=no` | null |
| outdoor_seating | `outdoor_seating=yes` | `outdoor_seating=no` | null |
| wheelchair | `wheelchair=yes` | `wheelchair=no` (`limited` → null + отметка) | null |
| indoor | `indoor=yes`/`location=indoor`; category_rule: culture(museum/gallery/theatre/cinema/library/arts_centre), mall, а также cafe/food с тегом `level` или внутри контура mall (только если вычислено при ingest) | category ∈ {park, playground}; tourism=viewpoint/artwork вне здания | null |
| kids | leisure=playground, `kids_area=yes`, `playground=*` на объекте | `kids_area=no` | null |

`null` = неизвестно. Жёсткое требование выполняется только при `value=true`. Пожелание с `null`
не заявляется как выполненное и попадает в `unknown_features`. Тишина/уют не имеют тегов в OSM:
только пожелание, всегда «не подтверждено».

## 3. Время и бюджет (без маршрутизатора)
- distance = геодезическое расстояние (haversine, WGS84 sphere R=6371008.8 м) от origin до `location`.
- walk_min(d) = ceil(d × 1.3 / 66.7) — коэффициент извилистости 1.3, скорость 4.0 км/ч (консервативно).
- outbound = walk_min(d); return = walk_min(d) если return_to_start иначе null.
- buffer = max(5, ceil(0.10 × (outbound + (return or 0)))).
- visit = min(default_visit, budget − outbound − return − buffer); если меньше min_visit → кандидат исключается.
- total = outbound + visit + (return or 0) + buffer ≤ time_budget_min. Каждая карточка — независимая альтернатива со своим полным бюджетом.
- distance.method = "geodesic", note «По прямой; реальный путь по улицам длиннее», timing.estimated = true.
- route = null всегда, пока ROUTING_PROVIDER=none. Линии маршрута на карте не рисуются.

## 4. Часы работы
- Парсинг `opening_hours` библиотекой `opening-hours-py`; часовой пояс Asia/Almaty.
- arrival = start_time + outbound; окно визита [arrival, arrival+visit].
- open: открыто на всём окне визита; closed: закрыто в момент прибытия или закрывается до конца визита; unknown: нет тега, ошибка парсинга, есть `PH`/`SH` (нет календаря праздников), или состояние библиотеки unknown.
- unknown ≠ open. При must_be_open кандидаты с unknown исключаются из совпадений (и предлагается relaxation).
- start_time: допустимо [now − 10 мин, now + 7 дней], иначе 422 `invalid_start_time`.

## 5. Жёсткие условия и пожелания
Hard: time_budget, return_to_start, walking_only, required_features, include_categories,
exclude_categories, must_be_open, max_distance — из UI-контролов (source=ui) или из явных
маркеров текста (source=text; детерминированный парсер: «обязательно», «только», «нужна/нужен/нужно»,
«без …», «внутри/в помещении», «поближе»). LLM НЕ добавляет hard-условия; LLM может только
переформулировать запрос для поиска и предложить мягкие предпочтения/категории.
Конфликты (include ∩ exclude; «только внутри» + только парк и т. п.) → status=needs_clarification.
Контролы UI имеют приоритет над текстом при противоречии (например, бюджет).

## 6. Pipeline /api/recommend
validate → rules-parse текста → (LLM: интерпретация запроса, опционально) → geo shortlist
(радиус из бюджета) → hard фильтры → lexical (pg full-text/trigram-free BM25-подобный по
описанию/имени/тегам) + semantic (cosine по активной модели) → RRF (k=60) + distance prior →
бюджет/часы → top-N (≤8) кандидатов в LLM → строгая JSON-схема {place_id, reason, activity}
→ валидация ID/схемы/ссылок → серверное обогащение фактов → ответ.
Ошибка LLM/невалидный JSON: 1 повтор с подсказкой; затем `mode=retrieval_only`, `status=degraded`,
предупреждение «ИИ временно недоступен — показаны найденные места без сгенерированных объяснений».
Ошибка embeddings: lexical+geo, `status=degraded`, предупреждение. Ни один шаблон не выдаётся за RAG.

## 7. Карта
`GET /api/map/{layer}`, whitelist: `buildings`, `roads`, `water`, `green`, `coverage`.
Файлы: `data/map/{layer}.geojson` + `data/map/manifest.json`, ETag = sha256 файла.
- buildings: Polygon/MultiPolygon (с внутренними кольцами); properties: `id` ("way/123"),
  `name`?, `building`, `levels`?, `height_m` (число), `min_height_m` (число, 0 по умолчанию),
  `height_source` ∈ {height, levels, estimate, default}, `estimate_basis` ∈ {type, area} при estimate.
  Высота: `height` (м) → `building:levels`×3.2 м → оценка по типу (гараж/сарай/киоск 3 м, дом 6 м,
  склад/ангар/навес 8 м) или для building=yes по площади (< 40 м² → 3 м, < 250 м² → 6 м) → 10 м (условно).
  min_height: `min_height` → `building:min_level`×3.2 → 0. Слои в `data/map` пересчитываются при следующем `make ingest`.
- roads: LineString; `id`, `highway`, `name`?.
- water: Polygon/LineString; `id`, `kind`, `name`?.
- green: Polygon/MultiPolygon; `id`, `kind` (park, garden, grass, forest, meadow, pitch...), `name`?.
- Координаты всегда [lon, lat]. Атрибуция «© OpenStreetMap contributors» обязательна.

## 7a. Базовая карта города (ADR-0002)
`GET /api/tiles/{tileset}/{z}/{x}/{y}[?v=<tiles_version>]`, tileset ∈ {`base`, `buildings`}, 0 ≤ z ≤ 15 (MapLibre
перезумирует дальше). `v` (hex ≤ 32) — только ключ кэша: версия архивов из `/api/basemap`, меняется при пересборке,
поэтому дневной кэш браузера не смешивает старые и новые тайлы; прокси пропускает только такой query.
Источник — `data/basemap/{astana-base,astana-buildings}.pmtiles` (собираются `make basemap`, не в git). Ответ:
200 `application/x-protobuf` (MVT без gzip; web-прокси сжимает gzip для клиента), 204 — пустой тайл, 304 по
`If-None-Match`; `ETag` = размер/mtime архива + id тайла, `Cache-Control: public, max-age=TILE_CACHE_MAX_AGE_SECONDS
(86400), must-revalidate`. 404 — неизвестный набор/вне диапазона, 503 `basemap_unavailable` — архивы не собраны.
Отдельный rate limit `RATE_LIMIT_TILES` (3000/мин); в access-логе путь сокращён до `/api/tiles/{set}` (z/x/y выдают
просматриваемый район).
- `base`: схема Protomaps Basemap v4 (слои earth, landuse, landcover, water, roads, places, pois, boundaries).
- `buildings`, слой `buildings`, feature id = id области osmium (way×2, relation×2+1): `h`, `mh` (м), `src` ∈ {height,
  levels, estimate, default}, `eb` ∈ {type, area}?, `lv`?, `kind` (значение building / building:part), `part`? (1 —
  building:part), `has_parts`? (1 — контур рисуется частями в 3D), `col`/`rcol`? (building:colour / roof:colour,
  нормализованы в #rrggbb и смягчены к нейтральному тону), `roof`? (roof:shape), `roofed`? (1 — у корпуса есть срезы
  крыши), `rs`? (1 — горизонтальный срез приближённой крыши/стилизации), `styl`? (1 — кураторская стилизация,
  не точная модель), `lbl`? (подпись стилизации).
`GET /api/basemap` → сводка `data/basemap/manifest.json`: bbox, источники, лицензии, `coverage` (граница OSM relation
3087155, площадь, `boundary_inside_tiles`), `height_source`, `estimate_rules`, `roofs`, `stylised_landmarks`,
`tiles_version`, `usage_mode` и `satellite` — `{enabled:true, tiles, maxzoom, attribution, license}` только при явно
заданном `APP_USAGE_MODE=noncommercial` и `MAP_SATELLITE=auto`, иначе `{enabled:false, reason}` (по умолчанию в коде —
`commercial`, fail-closed; `.env.example` для демо задаёт `noncommercial`). Web принимает тайлы спутника только с
`https://tiles.maps.eox.at/`. `/api/ready` содержит компонент `basemap` (ok/unavailable), он не блокирует готовность:
подбор мест и запасная карта работают без тайлов города. Сжатый прокси-ответ получает слабый ETag (`W/…`).
`GET /api/basemap/boundary` → GeoJSON административной границы Астаны (OSM, упрощение ~1 м).

## 8. Конфиденциальность
Логи: request_id, статус, длительности, число кандидатов, IDs мест; без сырого текста запроса и
без точных координат (максимум округление до 0.01° ≈ 1 км для метрик). Диалог хранится только во
вкладке браузера. Запросы к LLM уходят на сконфигурированный провайдер (по умолчанию локальный Ollama).
