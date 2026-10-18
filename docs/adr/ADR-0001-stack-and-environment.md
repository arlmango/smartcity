# ADR-0001: стек, провайдеры и источники данных

Дата: 2026-10-18. Статус: принято (координатор).

## Среда (инвентаризация)
- 4 vCPU, 15 GiB RAM, без GPU, ~30 GiB свободного диска; Docker 29.8.2 + Compose v5.6.0 (dockerd запускается вручную в облачной среде).
- Python 3.13.16 + uv; Node 22.22.0 + pnpm; Playwright Chromium 1194 предустановлен (/opt/pw-browsers).
- Исходящая сеть через политический прокси. `overpass-api.de` — соединение сбрасывается прокси (недоступен в этой среде).
  `maps.mail.ru/osm/tools/overpass` (публичный экземпляр Overpass, перечислен на wiki.openstreetmap.org/wiki/Overpass_API) — доступен, ответ ~15 с.
  `download.geofabrik.de` — недоступен. Docker Hub, registry.ollama.ai, PyPI, npm — доступны.
- Ключей OpenAI-compatible/иных AI API в окружении нет. Ключ Anthropic сессии не используется приложением (это не ресурс проекта).

## Решения
1. Стек по ARCHITECTURE.md: Next.js (App Router) + TypeScript + Tailwind + MapLibre GL; FastAPI + Pydantic + SQLAlchemy + Alembic; PostgreSQL 17 + PostGIS 3.6.4 + pgvector 0.8.1 (образ собирается из `pgvector/pgvector:0.8.1-pg17-bookworm` + пакет PostGIS из PGDG с закреплённой версией).
2. AI-провайдер по умолчанию — локальный Ollama 0.12.6 (MIT):
   - генерация `qwen2.5:3b` (digest 357c53fb659c…, Q4_K_M, загрузка 1.9 GB, RAM ~3 GB). Лицензия Qwen Research/Qwen license (qwen2.5-3b — Qwen Research License; допустимо для некоммерческого демо — см. docs/LICENSES.md).
   - embeddings `bge-m3` (digest 790764642607…, 1.2 GB, dim=1024, MIT). Мультиязычная, без префиксов query/passage для dense retrieval.
   - Скорость на этой машине (замер 2026-10-18): генерация ≈8 ток/с, prompt eval ≈ 50–100 ток/с. Ответ /api/recommend ожидается 30–90 с. Это CPU-инференс, не быстрый.
   - Альтернатива: любой OpenAI-compatible endpoint через `AI_PROVIDER=openai_compatible`, `AI_BASE_URL`, `AI_API_KEY` (секрет только в env). Не проверен в этой среде (нет endpoint).
   - Модели не скачиваются молча: `make models` явно выводит размеры и запрашивает подтверждение (`CONFIRM=1`).
3. Источник данных — Overpass API (read-only), endpoint настраивается `OSM_SOURCE_URL`. Запросы разбиты по группам категорий, пауза ≥2 с, таймаут, ограниченные ретраи с backoff, явный User-Agent, кэш сырых ответов в `data/snapshots/`. Редакторский API OSM 0.6 не используется.
4. Покрытие v1: прямоугольник [71.390, 51.075] – [71.445, 51.115] (`config/coverage.geojson`), расширение референсного bbox соседними кварталами.
5. Маршрутизатор не подключён (`ROUTING_PROVIDER=none`): геодезическое расстояние × 1.3, 4 км/ч, всё помечено «по прямой / примерно». Valhalla — optional, не настроен.
6. Векторный поиск: точный скан (без HNSW) — объём ~10² мест.
7. Безымянные детские площадки допускаются как места с серверной подписью «Детская площадка» и `name_is_generic=true` (иначе сценарий S3 невозможен на реальных данных; имя не выдумывается).
8. LLM не вводит жёсткие условия; жёсткие условия только из UI и детерминированного парсера явных маркеров.

## Последствия
- Время ответа ИИ на CPU заметно (десятки секунд): UI обязан показывать прогресс и кнопку «Отменить».
- Публичный Overpass-экземпляр может быть недоступен: ingest завершается статусом failed/partial без удаления базы.
