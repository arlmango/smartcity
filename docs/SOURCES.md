# Официальные источники и проверка возможностей

Проверены при подготовке пакета 18 октября 2026. Версии и возможности среды Claude Code всё равно проверяются при запуске; документация может измениться.

1. Claude Code custom subagents: https://code.claude.com/docs/en/sub-agents
Project-level agents задаются Markdown-файлами в .claude/agents с YAML frontmatter. Доступность изоляции и инструментов зависит от версии; use built-in capabilities, не выдуманный API. Subagents используют тот же бюджет, это не обход лимитов.
2. Claude Code cloud: https://code.claude.com/docs/en/claude-code-on-the-web
Работа идёт в облачной рабочей среде с репозиторием, а не от одного нахождения ZIP в стороннем хранилище. Не обещается неограниченная сессия.
3. MapLibre 3D buildings: https://maplibre.org/maplibre-gl-js/docs/examples/display-buildings-in-3d/
Extrusion применим к геометрии зданий; сам движок не создаёт достоверные высоты или покрытие.
4. OSM API policy: https://operations.osmfoundation.org/policies/api/
Editing API не является предпочтительным backend для read-only приложений; для проекта использовать подходящий extract/Overpass.
5. OSM tile policy: https://operations.osmfoundation.org/policies/tiles/
Нельзя считать стандартные public tile-сервера бесплатным неограниченным CDN, массово предзагружать их или скрывать attribution.
6. Overpass API: https://wiki.openstreetmap.org/wiki/Overpass_API
Read-only выборка OSM; ограничения конкретного endpoint и допустимый объём проверить перед ingest.
7. OSM copyright: https://www.openstreetmap.org/copyright
Указать лицензию исходных данных, сохранить attribution и оценить обязанности при распространении производной базы.
8. Ollama embeddings API: https://docs.ollama.com/api/embed
Реальные embeddings требуют выбранной доступной модели; не заменять случайными vectors. Совместимость, ресурсы и модельную лицензию проверить отдельно.

9. Protomaps daily builds: https://docs.protomaps.com/basemaps/downloads (список: https://build-metadata.protomaps.dev/builds.json), `pmtiles extract` по HTTP range: https://docs.protomaps.com/pmtiles/cli
Проверено 2026-10-19: сборка 20261018 доступна (~139 ГБ), вырезка Астаны ≈ 10 МБ. Старые сборки удаляются — в манифесте фиксируется ключ сборки.
10. Geofabrik Kazakhstan: https://download.geofabrik.de/asia/kazakhstan.html — `-latest` перенаправляет на датированный файл, рядом `.md5`.
11. EOxCloudless: https://cloudless.eox.at/license-non-commercial/ (CC BY-NC-SA 4.0 для 2018–2025, CC BY 4.0 для 2016), коммерческая лицензия: https://cloudless.eox.at/license-legal/. Разрешение 10 м/пиксель, тайлы до z14.
12. Проверка текстурированных 3D для Астаны (2026-10-19): Google Photorealistic 3D Tiles — ключ + биллинг, покрытие Астаны публично не подтверждено, общие условия Google запрещают использование с не-Google картами; Cesium ion, 2GIS MapGL, MapTiler, Mapbox, Esri World Imagery — аккаунт/ключ/подписка. Открытой LoD2/LoD3-модели Астаны не найдено. Без разрешения владельца ничего из этого не подключено.

Стек и архитектура в пакете являются проектным выбором, а не утверждением, что выбранные сервисы уже доступны в аккаунте или что продукт уже реализован.
