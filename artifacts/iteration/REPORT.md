# SmartCity: локальная итерация 19 октября 2026

Готово: компактное сравнение независимых вариантов, сохранение выбранного места и фокуса при завершении генерации, исправление перекрытия мобильного списка маркерами.

## Baseline и ограничения

- Проверенный remote HEAD/submission: c4c1b8d3f5113e3ce8f71dd2df8254156204b733. PR https://github.com/arlmango/smartcity/pull/1 OPEN, mergedAt=null; main=c0027c8.
- Отдельный clone `/Users/mango/Documents/Codex/2026-10-19/task-8/smartcity`, ветка `improve/alternatives-20261019`. Original `/Users/mango/smartcity` и его dirty manifests/docs не изменены.
- Preview http://127.0.0.1:3208, API существующего локального стека :8000. .env, доступность сети и базовый стек не менялись. Нет push/merge/deploy.
- Valhalla: только конфигурационные поля; /api/route=501, routing service и graph отсутствуют. На диске Kazakhstan PBF 214 MiB, машина 16 GiB RAM, 149 GiB свободно. Тяжёлая сборка и загрузки не запускались. Для настоящего маршрута нужен отдельный городской extract, измеренная сборка графа и интеграция независимых плеч в фильтры/бюджет/RAG. Пиковая RAM/время сборки не измерены.
- Предварительные фактические карточки уже реализованы в submission через streaming. В этой итерации нет изменений latency модели, API или алгоритма бюджета. Исходная математика возврата прошла существующие тесты, но расстояния остаются по прямой и не гарантируют своевременный возврат по улицам.

## Измерения и скриншоты

- SYNTHETIC браузерный сценарий: между началом первой и третьей подробных карточек 1593 px (1440/390), 1613 px (360). Новый обзор всех трёх вариантов занимает 496 px. Это размер интерфейса, не время решения пользователя и не ускорение inference.
- Baseline на неизменённом :3000: выбор сбрасывался после финального ответа во всех трёх viewport. После: выбор и фокус сохраняются; новый запрос/reset очищают выбор.
- Синтетическая задержка генерации в E2E 2500 ms. Не интерпретировать её как производительность модели.
- Реальный публичный demo origin, локальные DB/Ollama: первый прогон 3337 ms до карточек, 64840 ms до финала; подтверждающий прогон 5832/65288 ms. Оба без JS pageerror. Изменение времени между прогонами не является ускорением/регрессией, контролируемого latency-бенчмарка не проводилось.
- `before-*.png` — baseline UI с синтетическими фикстурами; `after-*.png` — итоговый UI с синтетическими фикстурами (названия явно отмечены). `live-*.png` — настоящие OSM данные и локальная модель. Финальные live скрины относятся ко второму прогону.
- Реальные места: Аллея мира и согласия, 25-ти летие Независимости, Line Brew (данные из API). Отображаемые часы — серверная оценка по данным OSM, не независимая проверка расписания.

## Проверки

PASS:
- Production Next build (`build.log`), TypeScript (`typecheck.log`), ESLint без warnings (`lint.log`). Для локально скопированных pnpm dependencies: `NODE_PATH="$PWD/node_modules/.pnpm/node_modules"`.
- 145 frontend unit tests / 13 files (`unit.log`), включая различение return=0/null и реальный ID выбранного варианта.
- 46 API domain tests (`domain.log`): точные границы бюджета, асимметричные плечи, возврат, hours/parser/constraints.
- 36 production Chromium E2E (`browser-final.log`): desktop1440, mobile390/360; reset/repeat, selection, stream failure, request retry, cancellation, stale response, offline, API down, input XSS, fallback, keyboard, axe.
- После финальной CSS-изоляции: 12 targeted production E2E (`browser-confirm.log`): сохранение выбора/фокуса, отсутствие горизонтального overflow, hit-test мобильной панели поверх маркеров, card↔map, axe. Все прошли.
- Два live-прогона (`live.log`, `live-confirm.log`, `live.json`), desktop/mobile screenshots визуально проверены.
- Независимый read-only review до и после исправлений: блокеров нет. JSON ID serialization и focus remount замечания исправлены.

NOT RUN / ограничения:
- Полный make verify, ingestion/DB integration, полный E2E-набор вне flow/alternatives, Firefox/WebKit, физический слабый телефон/GPU не запускались.
- Не добавлен отдельный E2E на исчезновение выбранного ID в финале или reset именно в середине stream. Код снимает исчезнувший выбор; reducer guards stale responses покрыты существующими unit tests.
- Первоначальный E2E поймал неоднозначный текстовый селектор после добавления обзора: scoped к подробной карточке, повтор прошёл. Первый build пересёкся с нашим dev output и упал на icon.svg; dev остановлен, production build прошёл. Это отражено как устранённые проверки, не скрытые PASS.
- Impeccable launcher недоступен (engine отсутствует и cache dir вне write roots); контекст и design/craft инструкции прочитаны напрямую. Не блокирует продукт.

## Воспроизведение

Из apps/web:
```
NODE_PATH="$PWD/node_modules/.pnpm/node_modules" node node_modules/next/dist/bin/next build
API_INTERNAL_URL=http://127.0.0.1:8000 node scripts/start-standalone.mjs 3208
E2E_PORT=3208 node node_modules/@playwright/test/cli.js test tests/e2e/alternatives.spec.ts tests/e2e/flow.spec.ts
node scripts/iteration-live.cjs
```

Точный час дедлайна 20 октября неизвестен. Рекомендуется перенести проверенный локальный diff после просмотра; настоящую маршрутизацию планировать отдельным ограниченным spike. Готовые MP4/PPTX/ZIP не затронуты.
