# Локальная пешеходная маршрутизация: оценка без сборки

19 октября 2026. Реализацию, image pull, установку пакетов, создание графа и изменение .env НЕ запускали. Следующий запуск ожидает решения родителя.

## Измерено

| Объект | Результат |
|---|---|
| PBF | `/Users/mango/smartcity/data/cache/osm/kazakhstan-261018.osm.pbf`, 224566151 bytes (214.16 MiB) |
| Timestamp из header | 2026-10-18T20:25:06Z; generator osmium/1.16.0 |
| Header bbox | 46.423040,40.553462 — 87.353590,55.507990. Это bounding box экстракта Казахстана, не точный полигон страны |
| Сохранённый MD5 sidecar | bac454e32b12ca601c921ab8674a83cd (в этом этапе заново не вычислялся) |
| Mac | 16 GiB физической RAM; 147 GiB свободного диска |
| Docker Desktop | aarch64, 10 CPU, 8319504384 bytes (7.75 GiB) RAM |
| Текущие контейнеры | Ollama 4.326 GiB; web 96.16 MiB; API 89.65 MiB; DB 83.44 MiB. Это snapshot, не гарантированный свободный объём |
| Локальные инструменты | pyosmium уже установлен в проектной .venv; `osmium` CLI и `valhalla_build_tiles` на PATH отсутствуют |
| Образы | Только SmartCity web/api/db и Ollama; Valhalla отсутствует |
| Read-only анализ PBF | 54.21 s, два последовательных прохода без создания extract/graph; исходный файл не изменён |

Счётчики (`pbf-counts.json`) включают highway ways хотя бы с одним узлом внутри bbox; это не подсчёт рёбер графа и не доказательство связности. Узлы включают любые типы, не только дороги. Ways целиком пересекающие bbox без внутренних узлов этим анализом не учитываются.

| Область | Примерная площадь прямоугольника | Nodes | Highway ways | Footway ways |
|---|---:|---:|---:|---:|
| Текущие рекомендации [71.390,51.075,71.445,51.115] | 17.1 km² | 55135 | 5310 | 2504 |
| Предлагаемый pilot buffer [71.35,51.04,71.48,51.15] | 111.0 km² | 222012 | 18191 | 8525 |
| Bbox городской карты [71.15,50.83,71.85,51.38] | 2988.9 km² | 710486 | 40280 | 13259 |

Сборку всей страны не предлагаю. Pilot buffer расширяет текущую зону на несколько километров для обходов; пользовательская зона рекомендаций остаётся прежней. Границы графа всё равно нужно проверять: если путь упирается в них, возвращать честную недоступность, не сокращать путь.

## Предлагаемый стек и точная новая загрузка

Официальный базовый Docker image Valhalla 3.8.3, linux/arm64, без автоматического scripted entrypoint:
`ghcr.io/valhalla/valhalla@sha256:58c7dd3fb256f306b00c558fb76aea9fd4fb804edd831e2b4847c26511cca507`.

Проверен только registry manifest: сумма шести compressed layers = **238975053 bytes (227.90 MiB)**, плюс несколько KiB metadata. Слои НЕ скачаны. Не требуется новый PBF. Unpacked image size до pull не измерен; зарезервировать до 2 GiB, не выдавать это за размер образа.

Base image выбран, чтобы исключить автоматические загрузки timezone/elevation/default speeds и пересборку при запуске. Пилот — pedestrian, без transit, elevation, live traffic и временных дорожных ограничений. Часы работы заведений по Asia/Almaty остаются в существующем API. Отсутствие timezone/admin на первом пилоте явно отразить в ограничениях; conditional access не обещать как проверенный.

Для выделения OSM можно использовать установленный pyosmium (есть BackReferenceWriter и ForwardReferenceWriter), сохраняя теги узлов/ways и зависимости restriction relations. Это потребует небольшого проверенного extraction script; наивная выборка только footway или только координат дороги неприемлема. `remove_tags=False` обязательно для referenced nodes/barriers. Сначала проверка целостности referenced nodes/ways, потом Valhalla. Если корректный extract нельзя обеспечить имеющимися библиотеками, остановиться и отдельно оценить osmium-tool; он не входит в проверенный runner Dockerfile. Ничего не устанавливалось.

## Оценка затрат и ограничения пилота

Точные размер графа, RAM peak и время сборки **невозможно честно назвать до сборки**. Следующие числа — инженерные резервы/гипотезы для разрешения ограниченного эксперимента, не измерения и не гарантии:

- Ожидаемый pilot extract порядка 5–30 MiB; graph порядка 10–100 MiB для 18k highway ways, возможен больший объём из-за полных зависимостей и tile boundaries. Контрольный предел graph/output 512 MiB.
- Резерв рабочего диска 3 GiB суммарно (image + extract + временные файлы + graph). Прекратить пилот при превышении, не расширять автоматически.
- Build: один поток (`-j 1`), container CPU limit 2, memory limit 2 GiB, без дополнительного swap за пределом лимита; максимум 15 минут собственно tile build. Несколько проходов extraction ориентировочно 2–4 минуты на основании 54 s read-only scan, но это не бенчмарк extraction.
- При OOM/timeout остановиться и передать peak/стадию/логи; не выгружать Ollama, не останавливать baseline и не менять Docker RAM самостоятельно. Остаток ~3.1 GiB в Docker до cache/overhead делает параллельную inference+build рискованной.
- Serving: стартовый предел 512 MiB и 1 CPU; проверить p50/p95/peak, увеличить только после решения. Не обещать latency до smoke.
- Инженерная интеграция и тесты ориентировочно 2–4 часа после работоспособного графа; данные и topology могут потребовать больше. Точный deadline пока неизвестен.

Нужны: разрешение на pull ~228 MiB, запуск двух ограниченных одноразовых контейнеров/build+serve и запись только в task-8. Runtime без исходящего internet; HTTP bind только 127.0.0.1:8208. Docker socket требует текущей sandbox escalation. Новые API keys, платный сервис, root package install, внешняя геолокационная API и изменения публичного доступа не нужны.

## Минимальная интеграция после разрешения

1. Отдельный routing spike и output path; pinned image/digest + manifest с OSM timestamp/bbox/checksum, версия конфигурации. Build в новом каталоге, health/smoke до выбора активного графа; старые версии не затирать.
2. Backend adapter с timeout, проверкой ответа/геометрии/units и строгим server-owned base URL. `costing=pedestrian`, walking_speed=4 km/h для соответствия текущему продукту, max snap distance проверять явно: один radius не гарантирует жёсткого cutoff у Valhalla.
3. Geodesic остаётся только безопасным shortlist lower bound. Для routed режима текущий detour=1.3 не использовать для prefilter, иначе будут потеряны достижимые места. Реальные пути вычислять ДО финальных budget/hours фильтров и RAG facts. Ограниченный shortlist, batch matrix обоих направлений; geometry для прошедших кандидатов, повторная проверка бюджета при расхождении с matrix. Не рассчитать route только для уже выбранного LLM места.
4. Каждое направление считать отдельно (A→B, B→A), ceil(seconds/60) для каждого; не умножать outbound на два и не добавлять 1.3 поверх router. `compute_timing` уже принимает раздельные плечи; visit + buffer остаются детерминированными. Opening window зависит от реального arrival/visit. Без return flag return=null.
5. Общие Python/Zod/OpenAPI контракты расширить: method=pedestrian_route только при валидном маршруте; explicit outbound/return legs, GeoJSON, duration/distance, snapped endpoints, provenance/version и availability. Сейчас response.route типизирован как None, поэтому это межмодульная задача, не один config switch.
6. `/api/ready` отражает реальный graph/provider status. Нет графа, timeout, no path, invalid response: route=null, явная ошибка/предупреждение. Допустим отдельный режим приблизительных рекомендаций с geodesic label; **никогда не рисовать прямую как fallback route** и не заявлять проверенный возврат. UI рисует только выбранный валидный маршрут; смена origin/request/reset удаляет старую линию.
7. Stream preliminary после фактической routed валидации, без ожидания LLM. Зафиксировать first-facts p50/p95 до/после; не терять выигрыш ранних карточек из-за десятков последовательных router calls. Никаких exact location/request bodies в логах; тестировать публичные demo points.

## Обязательные тесты перед признанием готовности

- Реальные публичные EXPO/MEGA → Аллея мира и согласия / 25-ти летие Независимости: pedestrian geometry идёт по графу и переходам, длина не совпадает искусственно с прямой, допустимое snapping, нет пересечения зданий/непроходимых ограждений. Проверять на OSM, не утверждать физическую доступность без полевой проверки.
- Синтетический маленький graph fixture: footway разрешён, foot=no запрещён, barrier/gate/steps/access, disconnected island, разные forward/return ограничения. Steps не выдавать за wheelchair route.
- A→B и B→A разной длительности; сумма outbound+visit+return+buffer<=budget; точная граница и +1 min; отсутствие возврата; часы закрываются по дороге/во время визита; router seconds округлены вверх.
- Нет graph, corrupt/incompatible graph, вне bbox, snap слишком далеко, no path, timeout, malformed response: честные состояния, без линии, без подмены метода, без ложного fitting budget.
- Map/card/selected geometry соответствует одному place_id; reset во время router call и stream; stale responses игнорируются; mobile, keyboard, retry; final LLM не меняет фактические route budgets.
- RAG: в prompt и final response только проверенные route timings, никаких придуманных мест, часов или маршрутов. При недоступном router не называть geodesic факты маршрутом.

## Источники

- Официальная установка: https://valhalla.github.io/valhalla/start/installation/
- Docker образы и поведение scripted defaults: https://github.com/valhalla/valhalla/blob/master/docker/README.md
- Runner 3.8.3 (без osmium CLI): https://raw.githubusercontent.com/valhalla/valhalla/3.8.3/docker/Dockerfile
- Graph build/optional datasets: https://valhalla.github.io/valhalla/contributing/architecture/mjolnir/
- Pedestrian costing, snapping и route responses: https://valhalla.github.io/valhalla/api/route/api-reference/

Упоминание 3.8.3 — оценённый pinned кандидат, не утверждение «последний» или доказанная пригодность. Тестирование локального графа ещё не выполнялось.
