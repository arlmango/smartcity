# Развёртывание (шаблон; публичный деплой не выполнялся)

## Требования
- Без локального AI: 2 vCPU, 2 GiB RAM, 5 GiB диска (db+api+web, данные покрытия ~десятки МБ).
- С локальным Ollama (qwen2.5:3b + bge-m3): +4 vCPU, +5 GiB RAM, +4 GiB диска; CPU-генерация 30–90 с на ответ. GPU ускоряет на порядок.
- Docker 24+ с Compose v2.

## Тома и бэкапы
- `smartcity_dbdata` — PostgreSQL. `make backup` → data/backups/*.dump (+sha256). Проверка: `make backup-test`.
- `make restore BACKUP=…` восстанавливает в НОВУЮ БД; `FORCE=1` заменяет `smartcity` только после автоматического бэкапа, старая БД остаётся как `smartcity_replaced_*`.
- `smartcity_ollama` — модели (воспроизводимо через `CONFIRM=1 make models`).

## Reverse proxy / TLS
Публиковать только web (порт 3000) за reverse proxy (Caddy/nginx) с TLS. API и БД слушают 127.0.0.1. `CORS_ORIGINS` = публичный origin. Браузер обращается к API через same-origin прокси Next.js.

## Readiness
`GET /api/ready`: db, data, map, embeddings, llm, routing. Compose ждёт healthcheck db → api → web (без sleep).

## Обновление
1. `make backup`. 2. `git pull`. 3. `make bootstrap` (миграции `alembic upgrade head`). 4. `make ingest && make index` (инкрементально, без дублей). 5. `make up`. 6. `make smoke-live`.

## Откат
`git checkout <prev>`; `make up`; при несовместимой миграции — `cd services/api && uv run alembic downgrade -1` либо `make restore BACKUP=… FORCE=1`.

## Модели
Смена `EMBEDDING_MODEL` требует `make index` (старые векторы другой модели не используются; `--prune-other-models` удаляет их).

## Пределы покрытия
v1 покрывает только config/coverage.geojson (район EXPO/MEGA Silk Way). Расширение: изменить полигон, `make ingest`, оценить объём карты (GeoJSON > ~20 МБ → переход на векторные тайлы).
