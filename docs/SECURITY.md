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
- Node: `pnpm audit --prod` — postcss в Next закреплён override на 8.5.30 (исправлены high/moderate).

## Принятый риск
| ID | Компонент | Суть | Почему принято | Что сделать |
|---|---|---|---|---|
| R1 | maplibre-gl 5.24.0 | GHSA «XSS Sanitizer Bypass in DOM.sanitize()», исправлено в ≥ 6.4.1 | `DOM.sanitize` вызывается только AttributionControl/Popup.setHTML. В SmartCity `attributionControl: false`, атрибуция — собственная React-ссылка, Popup не используется, все источники имеют пустую attribution. Обновление до 6.x проверено 2026-10-18: карта не инициализируется в E2E (мажорные изменения API) — требует отдельной миграции. | Миграция на MapLibre 6.x отдельной задачей; до тех пор не включать AttributionControl/Popup.setHTML с внешними строками. |
