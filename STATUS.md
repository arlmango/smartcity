# Статус

Обновлено: 2026-10-19 UTC. Этап: 5 — завершён. Итоговый gate: commit `9eade71` (чистый клон).
Ветка: `claude/wizardly-bardeen-py0dnc` (запушена). PR в `main` — открыт, не слит.

## Готово и проверено (подробно — docs/VERIFICATION.md, docs/FINAL_REPORT.md)
- Чистая установка по README в новом клоне: doctor → bootstrap → models → ingest из Overpass (`osm-20261018T223058Z`,
  126 мест) → index → up → ready.
- `make verify` на `9eade71`: 11/11 exit 0 (API 161, ingest 43 без skip, web unit 123, E2E 42 / 3 skipped-утилиты).
- `make smoke-live` на `9eade71`: PASS — API live S1/S2-relaxed/S3, Playwright live 24 passed / 2 skipped (вьюпорт),
  сценарий отказа провайдера на реальном втором экземпляре. Модель перед прогоном прогрета вручную.
- После ba066fe: CI исправлен (зелёный с `0b5b14a`), maplibre-gl 6.15.0 (GHSA-jrc7-96c5-q579 закрыт, regression-тест),
  найденные места показываются до ответа ИИ и сохраняются при таймауте модели.
- Инструкция запуска у себя: docs/LOCAL_RUN.md.

## Ограничения (не блокеры)
CPU-генерация 30–90 с (холодный старт ещё ≈ 35 с); качество текстов 3B-модели; нет пешеходного роутинга; малое
покрытие; нестабильный публичный Overpass; Firefox/WebKit не запускались; OpenAI-compatible провайдер не проверен живьём.

## Блокеры
Нет для обязательного MVP.
