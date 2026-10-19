# Итерация 2: «Схема» на старте, спутник только по согласию (2026-10-19)

01–07 сняты с основного стека http://localhost:3000 (Docker, `APP_USAGE_MODE` не задан → `commercial`): схема,
реальные данные (тайлы Protomaps 20261018, здания Geofabrik kazakhstan-261018, база мест osm-20261018T200514Z,
живой RAG ollama qwen2.5:3b + bge-m3). 08 — временный экземпляр :3010 с `APP_USAGE_MODE=noncommercial` (только env
процесса, `.env` не менялся) после явного согласия в диалоге.

- net-commercial-3000.json, net-noncommercial-3010.json — все запросы браузера по фазам (открытие, обзор, отказ,
  после согласия); внешние хосты перечислены отдельно.
- perf.txt — замеры на Apple Silicon; throttle-emulation.txt — ЭМУЛЯЦИЯ CPU в Chrome (GPU не эмулируется), не
  реальный телефон.
