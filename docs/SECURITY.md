# Безопасность: меры и принятые риски

## Меры (проверяются тестами: services/api/tests, apps/web/tests, tests/security/probe.py)
- Валидация входа (Pydantic strict, finite coordinates, длины, диапазоны), лимит тела 32 KiB (413, в т.ч. без Content-Length), rate limit по клиенту (429).
- Ключ клиента для rate limit: web-сервер перезаписывает X-Forwarded-For адресом сокета (apps/web/server-preload.cjs; `WEB_TRUSTED_PROXY_HOPS` для доверенного reverse proxy), API доверяет только последнему hop (`TRUST_FORWARDED_FOR`).
- SSRF: адреса AI/источника только из конфигурации; web-прокси — whitelist путей и методов, upstream только из env; ссылки на сайты мест — только http(s), строятся сервером.
- XSS: React-рендер текста, маркеры через textContent, нет dangerouslySetInnerHTML; CSP `default-src 'self'` (script-src требует 'unsafe-inline' для Next без nonce).
- Prompt injection: описания мест передаются модели как данные в разделителях; модель видит алиасы C1..Cn, сервер принимает только известные ID и удаляет неподтверждённые утверждения; модель не может добавить hard-условия.
- Логи без сырого текста запроса и точных координат (округление до 0.01°); access log uvicorn отключён; интерактивные /docs выключены (`API_DOCS=1` для разработки).
- Секреты только в env; scripts/secret_scan.py в `make verify` и CI.

## Зависимости (аудит 2026-10-18)
- Python: `pip-audit` — после обновления FastAPI 0.146.0 / Starlette 1.9.0 / pytest 9.1.1 известных уязвимостей нет (было 14 в starlette 0.48.0 и pytest 8.4.2).
- Node: `pnpm audit --prod` — 0 известных уязвимостей (postcss в Next закреплён override на 8.5.30; maplibre-gl 6.15.0).

## Закрытые риски
| ID | Компонент | Суть | Как закрыто |
|---|---|---|---|
| R1 | maplibre-gl ≤ 6.4.0 | GHSA-jrc7-96c5-q579: обход санитайзера `DOM.sanitize()` (XSS через атрибуцию) | Обновление до **maplibre-gl 6.15.0** (исправлено в ≥ 6.4.1). Воркер MapLibre 6 раздаётся с того же origin (`public/maplibre/maplibre-gl-worker.mjs`, `setWorkerUrl`), CSP не ослаблялась. Регрессия: `apps/web/tests/unit/maplibreVersion.test.ts` (версия ≥ 6.4.1, раздаваемый воркер побайтно равен установленному), E2E карты, `pnpm audit --prod` — 0 уязвимостей. Дополнительно атрибуция MapLibre отключена, Popup.setHTML не используется. |
