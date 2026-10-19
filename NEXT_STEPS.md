# Следующие действия

1. Ускорить ИИ: GPU-хост или разрешённый OpenAI-compatible endpoint (`AI_PROVIDER=openai_compatible`, секрет в env) —
   цель < 15 с на ответ; затем `make smoke-live` и `make eval` на новом провайдере (адаптер покрыт контрактными тестами,
   но живьём не проверялся — endpoint не предоставлен).
2. Пешеходный роутинг (optional): поднять Valhalla с экстрактом Казахстана, реализовать `POST /api/route` и учёт
   реальных плеч в бюджете (сейчас `routing_unavailable`, расстояния по прямой).
3. Данные: расширить зону рекомендаций (карта уже покрывает всю Астану) и категории (например, `museum=future`),
   периодически `make ingest` (`--retry-failed` при 504) и `make basemap` (сборки Protomaps хранятся недолго).
3a. Карта: фототекстуры фасадов возможны только через платные/учётные сервисы (Google 3D Tiles, Cesium ion, 2GIS) —
   требуется решение владельца и бюджет; проверить производительность 3D на слабых мобильных GPU; для коммерческого
   запуска — без спутника или с коммерческой лицензией EOX.
4. Firefox/WebKit smoke (`pnpm exec playwright install firefox webkit` в среде с разрешённой загрузкой браузеров).

Опасности повторного запуска:
- В облачной песочнице dockerd стартует вручную (`dockerd &`); сборка образов и загрузка моделей идут через прокси на
  127.0.0.1 → `export COMPOSE_FILE=docker-compose.yml:infra/compose.build-proxy.yml BUILD_CA_BUNDLE=/root/.ccr/ca-bundle.crt`,
  `OLLAMA_EXTRA_CA_BUNDLE=/root/.ccr/ca-bundle.crt` для `make models`.
- Перед live-smoke со сценарием отказа провайдера убедитесь, что порты 3011/8011 свободны (`fuser 3011/tcp 8011/tcp`):
  старые вспомогательные процессы дают ложный FAIL (см. artifacts/clean-install/20261018/smoke-run1-failed/ROOT_CAUSE.md).
- `make restore` без `FORCE=1` пишет в новую БД; `make down` тома не удаляет.
