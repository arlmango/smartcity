# Следующие действия
1. Дождаться отчётов агентов data-pipeline, backend-rag, frontend-map; проверить их worktree-ветки (тесты, команды) и слить в `claude/wizardly-bardeen-py0dnc`.
2. Интеграция: `make up`, ingest/index на живой БД, ручная проверка UI в Chromium (desktop/mobile), live S1–S3.
3. QA/security агент + independent reviewer по объединённому diff; исправления.
4. Полный quality gate в чистом окружении (`make verify`, `make smoke-live`), docs/VERIFICATION.md, docs/FINAL_REPORT.md.

Опасности повторного запуска: dockerd в облачной среде запускается вручную (`dockerd &`); контейнер `sc-ollama-probe` (Ollama с моделями в томе smartcity_ollama) использует host network и порт 11434 — не запускать параллельно compose-профиль ollama на том же порту.
