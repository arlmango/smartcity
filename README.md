# SmartCity

Веб-помощник для прогулок по Астане (район EXPO / MEGA Silk Way). Пользователь выбирает
реальную точку на карте, описывает прогулку и получает 1–3 места из собственной базы
OpenStreetMap: с бюджетом времени (дорога, визит, обратный путь, запас), статусом часов работы,
источниками и честными пометками о неизвестном.

- Карта: MapLibre GL на собственных GeoJSON-слоях из OSM (улицы, вода, зелень, контуры зданий с 3D-высотами и их происхождением). Без внешних тайлов и ключей.
- Поиск: гибридный — геофильтр и жёсткие условия, lexical + semantic (embeddings bge-m3, pgvector), RRF.
- RAG: генерация объяснений локальной моделью (Ollama, qwen2.5:3b) только по найденным кандидатам; сервер проверяет ID и подставляет все факты из БД.

Статус и доказательства: [STATUS.md](STATUS.md), [docs/VERIFICATION.md](docs/VERIFICATION.md), [docs/FINAL_REPORT.md](docs/FINAL_REPORT.md).

## Требования
Docker 24+ с Compose v2, `make`, [uv](https://docs.astral.sh/uv/) ≥ 0.11, Node 22 + pnpm 10.
Для локального AI: ~5 GiB RAM и ~4 GiB диска (CPU-генерация занимает 30–90 с на ответ). Подробнее: `make doctor`.

## Запуск из чистого клона
```bash
make doctor                 # проверка инструментов, ресурсов, портов, провайдеров
make bootstrap              # .env из .env.example, зависимости, БД, миграции (модели НЕ скачиваются)
CONFIRM=1 make models       # локальные модели Ollama (~3.1 GB): qwen2.5:3b + bge-m3
make ingest                 # ограниченный сбор OSM (Overpass) → БД, слои карты, manifest
make index                  # embeddings мест (инкрементально)
make up                     # db + api + web в Docker, ожидание healthcheck
open http://localhost:3000
```
За TLS-перехватывающим прокси (например, в песочнице CI) сборке образов нужен CA и прокси:
`export COMPOSE_FILE=docker-compose.yml:infra/compose.build-proxy.yml BUILD_CA_BUNDLE=/path/ca.crt` перед `make up`.

Без локальных моделей можно указать уже доступный OpenAI-compatible endpoint в `.env`
(`AI_PROVIDER=openai_compatible`, `AI_BASE_URL`, `AI_API_KEY`, то же для `EMBEDDING_*`).
Без AI приложение работает в режиме «ИИ временно недоступен» (поиск без сгенерированных объяснений).

## Команды
| Команда | Что делает |
|---|---|
| `make dev` | API (:8000, reload) + Next.js dev (:3000) локально |
| `make verify` | lint, format, typecheck, unit/integration, build, deterministic E2E, secret scan; отчёт в artifacts/verify/ |
| `make smoke-live` | live-сценарии на настоящих данных и моделях (pytest + Playwright без моков); отчёт в artifacts/live/ |
| `make eval` | 20 размеченных запросов (dev + holdout) против запущенного API; artifacts/eval/ |
| `make backup` / `make restore BACKUP=…` / `make backup-test` | резервная копия, восстановление в новую БД, проверка |
| `make down` | остановка (тома сохраняются) |

## Структура
```
apps/web/            Next.js UI + MapLibre
services/api/        FastAPI: endpoints, retrieval, generation, validation, миграции
services/ingest/     OSM ingest, нормализация, дедупликация, слои карты, индексация
packages/contracts/  OpenAPI snapshot
config/              полигон покрытия
data/                snapshots (ODbL), map layers, manifests
infra/               Dockerfiles
scripts/             bootstrap/ingest/index/verify/smoke/backup
tests/               фикстуры (синтетические), eval-запросы
docs/                архитектура, контракты, данные, RAG, приватность, лицензии, отчёты
```

## Документация
[SPEC.md](SPEC.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/CONTRACTS.md](docs/CONTRACTS.md) ·
[docs/adr/](docs/adr/) · [docs/DATA.md](docs/DATA.md) · [docs/RAG.md](docs/RAG.md) · [docs/FRONTEND.md](docs/FRONTEND.md) ·
[docs/PRIVACY.md](docs/PRIVACY.md) · [docs/LICENSES.md](docs/LICENSES.md) · [docs/deployment.md](docs/deployment.md) ·
[docs/DEMO.md](docs/DEMO.md)

## Данные
© OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright.
Высоты зданий частично приблизительны (по этажности или условные 10 м), это отмечено на карте.
Расстояния — по прямой, время — приблизительное: маршрутизатор не подключён.
