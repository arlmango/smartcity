# Приёмка: конкретные доказательства вместо «всё готово»

## Статусы
DONE = обязательные пункты PASS на текущем commit, zero P0/P1, QA и reviewer закрыли замечания. CODE_READY_AI_BLOCKED / BLOCKED_ENV / IN_PROGRESS — не DONE. OPTIONAL_NOT_CONFIGURED допустим только для функций, изначально объявленных optional (например уличный маршрутизатор, внешний basemap, public deployment).
P0: утечка секретов/данных, потеря данных, системное опасное действие. P1: сломан основной сценарий, неверные реальные факты/география, ложное выполнение hard constraints, неработающий ingest/RAG/map. P2/P3 перечислить с влиянием; косметические не превращать в блокеры без причины.

## Обязательные функциональные критерии
A01. Чистая установка по README выполняется без недокументированных ручных исправлений; lockfiles/миграции/Compose проверены.
A02. Реальный автоматический ingest закончился, есть manifest с источниками, фактическим покрытием, counts, датой, лицензией и hash.
A03. Повторный ingest того же snapshot не создаёт дубликаты; изменение одной записи обновляет её/embedding; частичный сбой не стирает базу.
A04. Карта отображает реальные улицы, EXPO и MEGA в правильных взаимных позициях. Сопоставить минимум 5 landmarks/контуров с исходными OSM объектами и записать IDs, не оценивать на глаз по картинке.
A05. Здания в 3D соответствуют реальным контурам; height_source известен; unknown heights обозначены как приближение. 2D/3D, pan/zoom/rotate, markers работают.
A06. Пользователь выбирает origin вручную; GPS только по запросу. Denied GPS не блокирует работу. Вне покрытия есть честное объяснение.
A07. Поиск действительно вычисляет document/query embeddings выбранной модели и комбинирует semantic+geo/category. Логи/тест показывают retrieval выбранных IDs.
A08. Настоящий LLM формирует ответы из реальной базы. Сохранить обезличенный live test transcript с provider/model, retrieved IDs и итогом. Шаблоны не заменяют этот PASS.
A09. Названия/координаты/источники из БД, карточки и markers имеют одинаковые IDs; неизвестный model ID отклоняется.
A10. Пройдены три основных сценария S1–S3, включая честное no_match для неподтверждённых обязательных удобств. Успешным тестом может быть корректный отказ, но нужен хотя бы один реально успешный полезный ответ для прогулки.
A11. Возврат/посещения/запас входят в budget каждой альтернативы. Нет маршрута — расстояние «по прямой», время «примерно», без обещания пройти за это время.
A12. Часы проверяются в Asia/Almaty на время прибытия/посещения. Unknown не становится open. Past/future request timestamp по контракту контролируется, не произвольное обходное значение.
A13. «Поближе/без кафе/только внутри» меняют результаты и не теряют hard constraints. Race conditions запросов не возвращают старую карту.
A14. Минимальный real dataset достаточен для осмысленного демо; никаких fake POI ради числа. Source/updated/unknown доступны пользователю.
A15. Неподдержанный WebGL даёт 2D/list fallback; mobile layout, keyboard и loading/error/empty проверены.
A16. Rate limiting, input validation, timeouts, secret scan, XSS/SSRF/prompt-injection сценарии проверены; точные координаты/сырой текст не попадают в обычные логи.
A17. Backend unit/integration, frontend unit, typecheck, lint, build, E2E реально выполнялись на финальном commit. Все ошибки объяснены/исправлены. Нет скрытых skip обязательных тестов.
A18. Independent reviewer проверил требования и diff, QA перепроверил исправления. Final report перечисляет не только успехи, но реальные ограничения.
A19. README+env+bootstrap+backup/restore+update scripts+privacy/data licenses+demo script существуют и соответствуют реальным командам.
A20. Каждый показанный основной UI control действует; нет фиктивного онлайн-рейтинга, погоды, активного маршрута или кнопки «Сохранить» без backend/local реализации.

## Автоматические unit/integration edge cases
T01 query empty/too long/Unicode; T02 invalid/NaN coordinates; T03 outside coverage; T04 no candidates;
T05 hard socket=true with unknown evidence => exclude; T06 preference socket with unknown => not claimed;
T07 exact budget boundary and buffer; T08 return trip required and asymmetric routed legs;
T09 closing before arrival; T10 closing during visit; T11 unknown hours; T12 hours past midnight in local zone;
T13 invalid LLM JSON; T14 unknown place_id; T15 prompt injection inside retrieved description;
T16 LLM timeout/429; T17 embedding provider down; T18 dimension mismatch after model change;
T19 OSM node/way duplicate; T20 partial ingest failure preserves prior records;
T21 removed POI after successful full snapshot; T22 coordinate order and geometry holes;
T23 disabled routing => no fabricated line; T24 stale response cancellation;
T25 XSS HTML in place/query; T26 arbitrary source URL / SSRF attempt; T27 negative duration/min>max;
T28 unknown child suitability and accessibility; T29 duplicate recommendations; T30 valid facts cannot be overwritten by LLM.

## Browser E2E (live и deterministic раздельно)
- Deterministic tests: изолированные fixtures + controlled provider stubs, репродуцируемая regression suite. Честно обозначена как такая.
- Live-smoke: настоящий frontend/api/db + реально собранный OSM snapshot + работающие embeddings/LLM. Никаких network mocks. Provider identity и dataset hash в отчёте. Хотя бы S1–S3 и failure modes с реальными компонентами.
- Desktop 1440×900, mobile 390×844, small mobile 360×800. Chromium обязательно; smoke Firefox/WebKit если доступны. Нельзя приписывать неисполненные браузеры.
- Скриншоты: initial, actual 3D map, real recommendations, selected card/marker, mobile, empty/no-match, unknown hours, provider failure. Не использовать reference PNG вместо screenshot работающего приложения.
- console errors/network failures: классифицировать каждый, не скрывать всё через catch/ignore.
- Map проверять до наличия реальных features, не только canvas existence. Наличие extrusion layer + source geometry + screenshot, корректное переключение 2D.
- Accessibility: автоматический axe + ручная клавиатура/контраст/порядок фокуса.

## Качество и производительность
Создай набор минимум 20 размеченных запросов: 10 для разработки + 10 holdout, не подгоняй под holdout без раскрытия. Разметка по фактам snapshot. Оцени groundedness, hard-constraint violations (должно быть 0), unknown handling, coverage/no-match, retrieval usefulness. Не рисуй научную точность на таком маленьком наборе; приложи каждый результат.

Измерь cold/warm load, map-ready, API latency p50/p95 на указанном hardware/concurrency, memory. Цели, не фальшивые гарантии: UI input отзывчив, карта ограниченного района ~3с после локальной загрузки, API с hosted моделью ~15с; для CPU локальной модели фактическое время сообщить отдельно. Длительные ответы имеют прогресс и cancel. Исключи лишнюю перезагрузку карты при вводе текста. Все performance-утверждения содержат среду и метод измерения.

## Порядок quality gate
1. Format/typecheck/lint.
2. Backend+frontend unit и integration.
3. Production build.
4. Clean bootstrap + ingest/index + health/readiness.
5. Deterministic E2E + live-smoke.
6. Security scan + accessibility + responsive review.
7. Independent review, fix, rerun affected tests.
8. Full gate на объединённом финальном commit; FINAL_REPORT.

Необязательная публичная публикация не требуется для DONE в локально/приватно запускаемой среде. Если запуск самого приложения невозможен, нельзя заменить A01/A17 инструкцией «запустите сами» и поставить PASS.
