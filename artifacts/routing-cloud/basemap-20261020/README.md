# Итоговый интерфейс с настоящей подложкой (облако, 20.10.2026)

Снято `apps/web/scripts/plan-live.cjs` из запущенного приложения (API :8108, web :3208, Valhalla :8208, Ollama).

## Что было на карте
- **Подложка — настоящая**: Protomaps build `20261019.pmtiles`, извлечена тем же pinned `go-pmtiles 1.31.2` и той же функцией
  `smartcity_ingest.basemap.build_base`, что и в `make basemap` (bbox города, 10 374 911 байт). Не закоммичена (`*.pmtiles` в .gitignore).
- **Собственные 3D-контуры зданий — только зона EXPO/MEGA**: Geofabrik (`download.geofabrik.de`) из облака недоступен
  (connection reset), поэтому `astana-buildings.pmtiles` собран разово скриптом вне репозитория из закоммиченного снимка
  `osm-20261018T200514Z/map_buildings.json.gz` (1 753 way → 1 829 зданий, без multipolygon-relations).
  Городские 75 039 контуров здесь **не проверены**. `data/basemap/manifest.json` и граница не менялись.

## Результат (`plan-live.json`)
План 2 остановки на 360/390/430/desktop, линия 3 участка, 2 метки, без горизонтального скролла, без ошибок страницы.
После «Убрать» — заметка «Без «Аллея мира и согласия» план не собрался.» и «Среди найденных вариантов не удалось собрать
прогулку на это время с возвратом к старту…». Первые карточки 4,3–8,7 с; финал 154 с (модель после перезапуска контейнера).

## Не проверено здесь
- Здания по всему городу из Geofabrik; реальный телефон; WebKit/Firefox.
- Метки остановок 1 и 2 частично перекрываются, когда концы участков ближе ~100 м (видно на `plan-map-mobile-390.png`).

## Проверка на Mac (полная подложка + здания)
```bash
git fetch origin && git checkout claude/laughing-hamilton-kmtk4o
make bootstrap                      # .env, зависимости, БД, миграции
CONFIRM=1 make models               # bge-m3 + qwen2.5:3b (~3,1 ГБ), если ещё нет
make ingest && make index           # или: scripts/ingest.sh import --from-snapshot osm-20261018T200514Z && make index
make basemap                        # Protomaps + Geofabrik → data/basemap/*.pmtiles (~240 МБ загрузки)
# локальный роутер: граф Mac-пилота (artifacts/routing-pilot/STATUS.md) на 127.0.0.1:8208.
# scripts/lib.sh читает .env поверх окружения, поэтому роутер включается в .env (не коммитить):
sed -i '' 's#^ROUTING_PROVIDER=.*#ROUTING_PROVIDER=valhalla#; s#^ROUTING_BASE_URL=.*#ROUTING_BASE_URL=http://127.0.0.1:8208#' .env
make dev                            # API :8000, web :3000 (Ctrl+C — остановить)
# во втором терминале, пока работает make dev:
cd apps/web && node scripts/plan-live.cjs http://127.0.0.1:3000 ../../artifacts/mac-check   # скриншоты + JSON
```
Смотреть: здания по всему городу видны за пределами зоны EXPO; линия плана лежит на дорожках; метки 1/2 читаются;
после «Убрать» есть заметка об изменении плана. `make basemap` перезапишет `data/basemap/manifest.json` и границу —
проверьте `git diff data/basemap` перед коммитом. Телефон: `make dev` слушает только 127.0.0.1, поэтому проверка на
телефоне требует отдельного решения о доступе (LAN/HTTPS-туннель) — в этой ветке не выполнялась.
