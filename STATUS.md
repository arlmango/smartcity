# Статус

Обновлено: 2026-10-18 ~20:40 UTC. Этап: 3→4 — интеграция завершена, идёт QA/security и независимое ревью.
Ветка: claude/wizardly-bardeen-py0dnc (слиты ветки агентов data-pipeline, backend-rag, frontend-map).

## Работает (проверено координатором на объединённой ветке)
- Docker-стек db+api+web+ollama(profile) собирается и поднимается с healthcheck; `/api/ready`: db, data (127 мест, osm-20261018T200514Z), map, embeddings (bge-m3, dim 1024, 127/127), llm (qwen2.5:3b) — ok; routing not_configured.
- Живой S1 через web-прокси: status ok, mode live_rag, 3 альтернативы, бюджет 38–40 из 40 мин; генерация 77 с на CPU (4 vCPU).
- Тесты: API 107 passed (не live), ingest 40 passed (отчёт агента), web unit 95 passed, typecheck/lint ok.
- Карта на реальных OSM-слоях: 1812 зданий, 5329 дорог; высоты 23 height / 897 levels / 892 default.

## В работе
- qa-security: live Playwright без моков, failure modes, безопасность, доступность, VERIFICATION.
- independent-reviewer: ревью требований и diff.

## Известные ограничения
- CPU-генерация 50–190 с на ответ; при перегрузке хоста возможен fallback retrieval_only.
- Overpass maps.mail.ru часто отвечает 504: ingest завершается partial, повтор `--retry-failed`.
- 66 из 127 мест — безымянные детские площадки (generic label); именованных мест 61.

## Блокеры
Нет.
