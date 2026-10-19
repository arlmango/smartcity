# Итоговые скриншоты карты (2026-10-19)

Сняты с основного стека `make up` → http://localhost:3000 (Docker: web + api + db + ollama), реальные данные:
тайлы Protomaps 20261018 + здания Geofabrik kazakhstan-261018, база мест osm-20261018T200514Z, живой RAG
(ollama qwen2.5:3b + bge-m3). Chrome for Testing 1248 (headless, ANGLE/Metal), Apple Silicon; 1600×1000 и 390×844 @2x.

01 — вся Астана (гибрид: спутник EOxCloudless 2024 на обзоре), граница OSM relation 3087155, зона рекомендаций.
02–04 — левый берег (Байтерек: ствол-контур + шар по roof:shape=orb), правый берег (Кенесары/Абая), EXPO (Нур Алем —
кураторская стилизация, подписана). На уровне улиц гибрид переходит в схему.
05 — EXPO в режиме «Схема».
06–09 — живой ответ RAG (status ok, mode live_rag): маркеры = карточки, выбранное место в центре кадра.
perf.txt — замеры (метод в docs/VERIFICATION.md).
