# SmartCity — веб-клиент (apps/web)

## Стек и версии (зафиксированы в `apps/web/package.json` + `pnpm-lock.yaml`)
Node 22, pnpm 10.28.0, Next.js 15.5.28 (App Router, `output: "standalone"`), React 19.1.10, TypeScript 5.9.3 (strict,
`noUncheckedIndexedAccess`), Tailwind CSS 3.4.19, MapLibre GL JS 5.24.0, Zod 3.25.76, TanStack Query 5.104.4,
шрифт Manrope (@fontsource/manrope 5.3.0, OFL-1.1, self-hosted). Тесты: Vitest 3.2.7 + Testing Library, Playwright 1.56.1
(Chromium 1194 из `PLAYWRIGHT_BROWSERS_PATH`, без `playwright install`) + @axe-core/playwright 4.14.0.

## Команды (из `apps/web`)
| команда | что делает |
|---|---|
| `pnpm install --frozen-lockfile` | зависимости |
| `pnpm dev` | dev-сервер на :3001 (3000 — для координатора/Docker) |
| `pnpm build` / `pnpm start` | production standalone-сборка / запуск её на :3000 (`scripts/start-standalone.mjs`) |
| `pnpm lint`, `pnpm typecheck` | ESLint (next/core-web-vitals, 0 warnings), `tsc --noEmit` |
| `pnpm test` | Vitest (unit/component) |
| `pnpm test:e2e` | Playwright deterministic E2E (сам собирает и поднимает standalone на :3100; `E2E_SKIP_BUILD=1` — без пересборки) |
| `SCREENSHOTS=1 pnpm test:e2e tests/e2e/screenshots.spec.ts` | скриншоты на SYNTHETIC фикстурах в `artifacts/screenshots/frontend-dev/` |
| `node scripts/screenshot-map.mjs <outDir>` | скриншоты работающего dev-сервера (:3001) — использовался для реальных OSM-слоёв |
| `pnpm glyphs` | перегенерировать PBF-глифы карты из Manrope |

Docker: `docker build -f infra/docker/web.Dockerfile -t smartcity-web:0.1.0 .` из корня репозитория
(multi-stage `node:22.22.0-slim`, `pnpm install --frozen-lockfile`, `next build` standalone, пользователь `node`, порт 3000).
Контекст ограничен файлом `infra/docker/web.Dockerfile.dockerignore` (только `apps/web`, без node_modules/.next/tests).
За TLS-перехватывающим прокси: `--network host --build-arg HTTPS_PROXY=... --secret id=build_ca,src=<ca.crt>`
(сертификат монтируется как BuildKit secret и не попадает в слои).

## Связь с API
Браузер ходит только на same-origin `/api/*`. `src/app/api/[...path]/route.ts` → `src/server/proxy.ts` проксирует на
`API_INTERNAL_URL` (по умолчанию `http://localhost:8000`; в образе `http://api:8000`), **читая переменную на каждый запрос**
(rewrites в next.config вычисляются при build и не подходят для Docker). Прокси:
- whitelist путей и методов: `GET health|ready|coverage|map/{buildings,roads,water,green,coverage}|places|places/{id}|search`,
  `POST recommend|route`; всё остальное — 404 JSON без обращения к upstream;
- query string передаётся только для `places` и `search` (≤2048 символов); тело POST ≤64 КБ;
- хост берётся только из env сервера (нет open proxy/SSRF), редиректы upstream не следуют;
- таймауты: recommend 150 с, map 30 с, остальное 10–15 с; отмена запроса в браузере обрывает upstream-запрос;
- upstream недоступен → 502 `api_unreachable`, таймаут → 504.
- `WEB_DEV_MAP_DIR` (только не-production): отдавать `/api/map/{layer}` из локальных GeoJSON — для проверки рендера карты
  на файлах data-pipeline до появления API.

### X-Forwarded-For (защита rate-limit от подмены)
Next.js сохраняет клиентский `X-Forwarded-For`, поэтому сервер запускается с preload-модулем
(`node -r ./server-preload.cjs server.js` в Docker, `pnpm start`, `pnpm dev` через `NODE_OPTIONS`). Он на событии
`request` у `http.Server` заменяет XFF одним адресом (`forwarded-for.cjs`): по умолчанию — адрес TCP-сокета
(клиентский XFF отбрасывается); при `WEB_TRUSTED_PROXY_HOPS=N` — адрес перед N последними доверенными hop'ами
(цепочка `[...XFF, сокет]`); `Forwarded`/`X-Real-IP` удаляются. Прокси `/api` пересылает XFF только если preload
активен в процессе и значение — один IP; иначе XFF не пересылается вовсе. Проверено unit-тестами, E2E
`tests/e2e/xff.spec.ts` (заглушка upstream получает `127.0.0.1` при подделанном `6.6.6.6`) и в Docker-образе.

### Заголовки безопасности
`next.config.ts`: `Content-Security-Policy` (`default-src 'self'`; `script-src 'self' 'unsafe-inline'` — Next без nonce
вставляет inline bootstrap-скрипты; `'unsafe-eval'` и `ws:` только в `next dev`; `style-src 'self' 'unsafe-inline'`;
`img-src 'self' data: blob:`; `worker-src/child-src 'self' blob:` для воркеров MapLibre; `connect-src 'self'`;
`object-src 'none'`; `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
`X-Frame-Options: DENY`, `Permissions-Policy`. E2E `tests/e2e/csp.spec.ts` проверяет заголовки и отсутствие нарушений
CSP при загрузке карты и подборе (production-сборка).

Контракт: `src/lib/contracts.ts` — Zod-зеркало `services/api/smartcity_api/contracts.py`. Запросы `.strict()`; ответы
проверяются целиком (неизвестные поля отбрасываются, все используемые поля обязательны и типизированы; дубли `place_id`,
>3 рекомендаций, `timing.estimated≠true`, `route≠null`, даты без часового пояса отклоняются). Невалидный ответ → состояние
ошибки «Сервер вернул ответ в неожиданном формате», не падение. Ответ `/api/recommend` с чужим `client_request_id` отклоняется.
Слои карты валидируются по объектам (`src/lib/mapData.ts`): неверная геометрия/свойства → объект пропускается и
показывается «Неполные данные: N объектов пропущено».

## Карта
- Город целиком (ADR-0002). Стиль собирается в коде (`src/lib/mapStyle.ts`) из векторных тайлов `/api/tiles/base` (Protomaps:
  земля, landuse, вода, дороги, подписи районов/улиц/парков) и `/api/tiles/buildings` (собственные здания) — грузится
  только видимая область; плюс GeoJSON `coverage` (зона рекомендаций, `/api/map/coverage`) и `boundary` (граница Астаны,
  `/api/basemap/boundary`). Полные GeoJSON-слои района грузятся только для запасной SVG-карты. POI базовой карты иконками
  не показываются — места на карте только из базы рекомендаций.
- Подложка: «Гибрид» (по умолчанию, если API разрешает спутник) — EOxCloudless 10 м/пикс на обзоре города, плавный
  переход к схеме на z14.5–16, с z16 спутниковый слой не рисуется (нет запросов и атрибуции EOX); «Схема» — только
  вектор. Переключатель: сегменты справа снизу (desktop), кнопка-иконка в колонке контролов (телефон). Выбор хранится в
  localStorage (`smartcity.basemap`, только удобство). Смена подложки — `map.setStyle(…, {diff: true})`, маркеры и данные
  сохраняются. При `APP_USAGE_MODE=commercial` API не отдаёт спутник — переключателя нет, к EOX запросов нет.
- 3D: `fill-extrusion` по `h`/`mh`. Измеренные высоты (`src` height/levels) — слой `buildings-3d`; оценки и условные —
  `buildings-3d-approx` (светлее, opacity 0.82, в 2D — пунктирный контур). Цвет — спокойная шкала по высоте, тег
  building:colour (смягчённый) тонирует стены. Крыши: тонкая светлая плита на плоских крышах; ступенчатые срезы `rs` по
  тегу roof:shape (скатные, купола, шары). Нур Алем — кураторская сфера с подписью «Нур Алем · стилизация».
  Контуры, нарисованные частями (`has_parts`), в 3D скрыты. Свет — нейтральный, sky/fog для горизонта при наклоне.
- Легенда «Высоты зданий — приблизительно» повторяет кодировку карты: «Измерено — сплошные» (высота из OSM, этажи ×
  3,2 м; оттенок по высоте) и «Оценки — светлые, полупрозрачные» (по типу или площади; условно 10 м) с числами из
  `/api/basemap`; сворачивается, когда появились результаты. Правила оценок в «О данных» берутся из `estimate_rules` API.
- Карта создаётся после ответа `/api/basemap` (единицы мс): URL тайлов содержат `?v=tiles_version`, а наличие спутника
  зависит от режима лицензии. То же в «О данных», где
  отдельно указаны покрытие карты («вся Астана в административных границах OSM, 794 км²») и база мест (район EXPO).
- Выбор точки вне зоны рекомендаций отклоняется: «Вне зоны рекомендаций… карта показывает всю Астану, но база мест…» +
  кнопка «Показать зону» (fitBounds по зоне).
- 2D/3D: переключение видимости слоёв extrusion ↔ плоские fill+outline и pitch 55 ↔ 0 (easeTo 600 мс).
- Камера: клик карточки или маркера → flyTo к месту (1,1 с, на телефоне — после изменения шторки), «Показать
  результаты» → fitBounds старта и мест; `maxBounds` ограничивает город. При `prefers-reduced-motion` — jumpTo.
- Контролы справа (44×44): +, −, 3D-здания, «На север», «Показать результаты», (телефон) подложка. ScaleControl слева
  снизу, атрибуция справа снизу: «© OpenStreetMap contributors · Protomaps» + в гибриде на обзоре — полная атрибуция
  EOxCloudless с лицензией (на телефоне мельче, но полностью).
- Начальная камера: центр [71.414, 51.089], zoom 15, pitch 55 — район EXPO/MEGA, не геопозиция.
- **Глифы**: PBF из Manrope Regular/SemiBold/Bold (`scripts/generate-glyphs.mjs`) в `public/fonts/<stack>/`; внешнего
  glyph-CDN нет. Лицензия шрифта — `public/fonts/OFL-Manrope.txt`.
- Нет WebGL / ошибка создания карты / потеря контекста / карта не загрузилась за 20 с → `FallbackMap` (SVG тех же
  GeoJSON района, маркеры, выбор точки, список). Ошибка `/api/basemap` → явное предупреждение «Базовая карта города
  недоступна» с повтором.
- Отладочный хук (без секретов): `window.__smartcityMap` и `window.__smartcity` `{loaded, viewMode, variant,
  sourceCounts, markerIds}` — используется E2E.
- E2E используют SYNTHETIC-тайлы `tests/fixtures/tiles` (генерирует `scripts/make_e2e_tiles.py`), не реальные данные.

## Интерфейс и состояния
- Десктоп: шапка (SmartCity, «Астана», формулировка задачи, поповер «О данных»: покрытие, число мест, дата снимка OSM,
  обновление, версия, OSM/ODbL, приблизительность высот, состояние компонентов из `/api/ready`, «Кто обрабатывает
  запрос»: Ollama → «локальная модель — текст не покидает сервер», openai_compatible → предупреждение, что текст
  отправляется внешнему провайдеру (+ заметка под CTA); данные из `/api/ready` detail и `providers` последнего ответа), левая панель 392 px,
  карта на остальной площади. Мобильный (<1024 px): карта сверху, нижняя шторка в 3 состояниях (свернута/половина/полная),
  переключатель «Карта / Список», safe areas, контролы ≥44 px.
- Форма: точка старта (клик по карте в режиме выбора / «Центр карты» для клавиатуры; «Моё местоположение» — сначала
  пояснение, GPS только по кнопке «Разрешить запрос», отказ/ошибка → понятное сообщение; «Демо-точка» из
  `/api/coverage.default_origin` с явной подписью; поиск по своей базе `/api/search`). Точка вне полигона покрытия не
  принимается: «Вне зоны покрытия данных…». Текст ≤2000 со счётчиком, 9 интересов-чипов, время 20/40/60/90 или 10–180,
  «Вернуться сюда», «Только пешком» (информация), раскрывающиеся обязательные условия (розетки, Wi‑Fi, в помещении,
  коляски, для детей, открыто во время визита, без кафе и еды). «Начало: Сейчас / Указать время» — datetime в пределах
  [сейчас, +7 дней] по времени Астаны, отправляется как ISO с `+05:00` (Казахстан с 2024 — единый UTC+5 без перехода;
  смещение зафиксировано, чтобы не зависеть от устаревшей tzdata браузера); по умолчанию `start_time` не отправляется.
  В результате: «Часы работы проверены на время прибытия при старте …». Условия из быстрых уточнений показываются чипами и снимаются.
- Запрос: прогресс с примерными этапами и секундомером (сервер не стримит прогресс — это сказано в UI), «Отменить»
  (AbortController). Защита от гонок: редьюсер `src/lib/recommendState.ts` применяет ответ/ошибку только для активного
  `client_request_id`; новый запрос абортит предыдущий. «Повторить» после сетевой/5xx/429 ошибки отправляет тот же
  запрос с тем же `client_request_id` (сервер может дедуплицировать).
- Результат: статус, плашка `retrieval_only` «ИИ временно недоступен — показаны найденные места без объяснений ИИ»,
  message, warnings, «Как мы поняли запрос» (hard с источником «из настроек/из текста», пожелания, пересказ).
  Карточки 1–3: номер = номер маркера, категория иконка+подпись, название (generic → «… · без названия в OSM»),
  «Почему подходит» (метка «ИИ»/«по правилам»), «Идея» (метка «оценка»), «По прямой N м» + note + «Время приблизительное»,
  таблица дорога/на месте/обратно/запас/итого из бюджета, статус часов (unknown → «Часы не указаны», никогда «открыто»)
  + raw часы, подтверждённые признаки с раскрываемым evidence, неподтверждённые и отрицательные признаки рядом,
  ссылки OSM/сайт только http(s) с `rel="noopener noreferrer"`, дата данных, поля источника. Оценки — пунктирные блоки
  с меткой, факты — метка «факт · OSM».
- no_match: объяснение + кнопки `suggested_relaxations` (patch отправляется как есть). needs_clarification: вопрос +
  «Изменить условия». Уточнения «Поближе» (max_distance_m ≈70% от самого дальнего, мин. 100 м), «Без кафе», «Только
  внутри», «Другие варианты» (exclude_place_ids ≤20) — сохраняют прежние hard-условия. `conversation_context` (≤6 реплик,
  ≤500 символов) только в памяти вкладки. «Начать заново» очищает форму, результаты, контекст.
- Карточка ↔ маркер: общий `place_id`; клик карточки → маркер выделен (лайм) + fly-to; клик маркера → карточка
  `aria-current`, прокрутка панели к ней и фокус.
- Баннеры: offline (navigator.onLine + события, CTA заблокирован), «API недоступен» (ошибка `/api/ready`), «Сервис не готов»,
  «ИИ сейчас недоступен», «Поиск по смыслу недоступен» (компоненты `/api/ready`); ошибки слоёв карты с «Повторить».
- Нет фиктивных элементов (аккаунт, избранное, рейтинги, погода, «Сохранить», маршрут).

## Доступность и цвет
Палитра DESIGN.md, проверенная по WCAG: graphite #17201C на #F6F7F2 — 15.5:1, muted #59645D на #F6F7F2 — 5.7:1
(на белом 6.2:1), graphite на lime #D9F66F — 13.8:1; лайм только как фон CTA/выбранного маркера, не как цвет текста.
Предупреждения #9A4A00 на #FFF4E5 — 5.8:1, ошибки #8F2D1F на #FDEDEA — 7.2:1, факты #1F5E3B на #E8F3EC — 6.8:1.
Labels/aria для всех контролов, `:focus-visible` 3 px, skip-link к панели, клавиатура для формы/карточек/контролов карты
(холст MapLibre — встроенные стрелки/+/−), `prefers-reduced-motion`. axe (wcag2a/aa, 21a/aa) без serious/critical.

## Тесты
- Unit/component (Vitest, `tests/unit`): Zod-валидация (валидный/невалидный ответ), форматирование тайминга/дистанции/
  часов, `safeHttpUrl`, редьюсер и защита от устаревших ответов (T24), контекст ≤6, построение стиля карты
  (валидность по style-spec, только geojson-источники, extrusion по height_m/min_height_m, прозрачность default,
  2D/3D), разбор слоёв и point-in-polygon с дырами и порядком [lon,lat], сборка запроса и уточнения, XSS в названии
  как текст (T25), ссылки только http(s), API-клиент (ошибки, abort, чужой client_request_id), whitelist прокси.
- Deterministic E2E (Playwright, `tests/e2e`, SYNTHETIC фикстуры `tests/fixtures/synthetic.ts` + `page.route`):
  desktop 1440×900 — все сценарии; 390×844 и 360×800 — помеченные `@mobile`. Это **не** live-smoke: реальный API/БД/LLM
  не участвуют.
- Live-интеграция с настоящим API — после слияния (координатор).
