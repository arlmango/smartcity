# Данные и лицензии

| Компонент | Лицензия | Обязанности |
|---|---|---|
| Данные OpenStreetMap (места, контуры, дороги) | ODbL 1.0, © OpenStreetMap contributors | Атрибуция «© OpenStreetMap contributors» со ссылкой https://www.openstreetmap.org/copyright на карте и в «О данных». Производная база (data/snapshots, БД) при публичном распространении — под ODbL (share-alike). |
| Overpass API (maps.mail.ru) | публичный сервис, условия экземпляра | Ограниченный объём, паузы, кэш снимка, явный User-Agent. |
| Ollama | MIT | — |
| bge-m3 (BAAI) | MIT | — |
| qwen2.5:3b (Alibaba Qwen) | Qwen Research License | Только некоммерческое/исследовательское использование. Для коммерческого запуска заменить модель (например, через OpenAI-compatible endpoint или Apache-2.0 модель) — `AI_MODEL`. |
| PostgreSQL / PostGIS / pgvector | PostgreSQL License / GPL-2.0 / PostgreSQL License | — |
| MapLibre GL JS | BSD-3-Clause | — |
| Базовые тайлы города: вырезка сборки Protomaps Basemap (build.protomaps.com, 20261018) | ODbL 1.0 (производная работа OSM; Natural Earth на малых зумах — public domain) | Атрибуция «© OpenStreetMap contributors» со ссылкой + «Protomaps» на карте. Файл `data/basemap/astana-base.pmtiles` не коммитится, собирается `make basemap`. |
| Здания и граница города: выгрузка Geofabrik `kazakhstan-YYMMDD.osm.pbf` | ODbL 1.0, © OpenStreetMap contributors | Проверка md5 Geofabrik; производные `astana-buildings.pmtiles`, `astana-boundary.geojson` — под ODbL. |
| Спутниковая подложка EOxCloudless 2024 (tiles.maps.eox.at, слой `s2cloudless-2024_3857`) | CC BY-NC-SA 4.0 (слои 2018–2025), только некоммерческое использование | Атрибуция рядом с изображением со ссылками: «EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024), colours adjusted by SmartCity» + ссылка на лицензию (изменения изображения — тон/контраст — обозначены). Не подразумевать одобрение ЕК/ЕКА. Слой доступен только при явном `APP_USAGE_MODE=noncommercial` (по умолчанию — `commercial`, слой не загружается; коммерческой лицензии EOX нет). Тайлы не кэшируются и не проксируются сервером. Браузер обращается к EOX только после явного согласия пользователя в режиме «Гибрид» (старт всегда «Схема»). Остаточный риск: CSP веб-сервера статична и разрешает `tiles.maps.eox.at` в `img-src`/`connect-src` во всех режимах (заголовки собираются при сборке); приложение в `commercial` к EOX не обращается (сетевые тесты). |
| go-pmtiles CLI 1.31.2 (сборка, не в рантайме) | BSD-3-Clause | версия и sha256 закреплены в `services/ingest/smartcity_ingest/basemap.py` |
| pmtiles (PyPI 3.8.1), osmium/pyosmium 4.3.1, mapbox-vector-tile 2.2.0 | BSD-3-Clause / BSD-2-Clause / MIT | — |
| Шрифт Manrope | SIL OFL 1.1 | self-hosted |

Интернет-рейтинги, отзывы и фото не используются и не копируются.
