# Статус

Обновлено: 2026-10-18 (UTC). Этап: 2 — параллельная реализация (ingest / API+RAG / UI+карта).
Базовый commit: c0027c8 (контракты, схема БД, адаптеры провайдеров, compose-каркас).

## Готово и проверено координатором
- Инвентаризация среды: 4 vCPU, 15 GiB RAM, без GPU, Docker 29.8.2 (dockerd запущен вручную). См. docs/adr/ADR-0001.
- Образ БД PostgreSQL 17 + PostGIS 3.6.4 + pgvector 0.8.1 собирается; миграция 0001 применена (dev + test БД).
- Реальные AI-провайдеры: локальный Ollama 0.12.6; `bge-m3` (dim=1024) и `qwen2.5:3b` отвечают через адаптеры проекта (probe 2026-10-18).
- Overpass: maps.mail.ru доступен; overpass-api.de недоступен из среды.

## В работе (агенты, изолированные worktree)
- data-pipeline: services/ingest, data/*, реальный ingest.
- backend-rag: services/api (endpoints, retrieval, generation, тесты, live S1–S3).
- frontend-map: apps/web (MapLibre 3D, панель, карточки, E2E).

## Не готово
Всё приложение, тесты, E2E, live-smoke. Ни один пункт A01–A20 ещё не PASS.

## Блокеры
Нет внешних блокеров на текущий момент.
