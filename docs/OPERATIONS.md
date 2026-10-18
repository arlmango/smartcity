# Запуск, агентная работа и завершение

## Фазы
0. Инвентаризация repo/env, применимые инструкции, ресурсы, сеть, версии. Записать assumptions, blockers и выбранный режим providers.
1. Контракты API, data schema, migrations, каркас Compose и вертикальный срез реального POI.
2. Параллельно: UI/map; data ingest; retrieval/generation. Координатор утверждает shared contracts.
3. Интеграция, три user journeys, безопасные fallback.
4. QA+security+independent review; исправления.
5. Чистый запуск, live-smoke, screenshots, performance, docs, final report.

В каждом этапе конкретный результат, а не бесконечное исследование. Не увеличивай scope погодой, аккаунтами и социальными функциями до обязательного DONE.

## Агенты
Координатор в основной сессии. frontend-map отвечает apps/web; backend-rag — services/api; data-pipeline — services/ingest и data manifests; qa-security — tests и verification; independent-reviewer — независимый read/review. Схемы/миграции/package lockfiles/Compose интегрирует координатор, либо назначает одного владельца. Backend и ingest не создают конкурирующие схемы.

Пять ролей не означают пять параллельных дорогих сессий обязательно: запусти 2–3 независимых worker одновременно по возможностям/лимитам. Read-only reviewer получает diff+SPEC+evidence, ищет проблемы, не выдаёт одобрение по словам автора. Если изоляция worktree недоступна, безопасное ownership файлов; если нет subagents — последовательные роли и честно указать, что независимого агента не было. Не выдумывать инструменты Claude и не включать experimental features глобально без необходимости.

Файлы .claude/agents — реальные шаблоны custom subagents с минимальным frontmatter. Сначала проверь совместимость установленной версии. Координатор может адаптировать имена/tools по текущим официальным docs. Не выдавать документированную возможность конкретной версии за факт доступности в этой среде.

## Команды, которые нужно реализовать
Не являются уже существующими скриптами; создай их и проверь:
- make doctor — версии, env, port conflicts, ресурсы, доступность providers без утечки секретов.
- make bootstrap — безопасный idempotent setup, compose up, migrations; без молчаливого скачивания моделей больших размеров.
- make ingest — разрешённый bounded ingest из configured source, статистика/manifest.
- make index — совместимые embeddings, incremental reindex.
- make dev / make up / make down — предсказуемый запуск; down не удаляет volumes.
- make verify — lint/typecheck/unit/integration/build/deterministic E2E, nonzero exit при failure.
- make smoke-live — настоящие data/providers, записывает LIVE evidence; не может PASS без LLM.
- make backup / make restore BACKUP=... — сначала backup-test на тестовой БД; restore никогда не overwrites prod молча.

README даёт точную последовательность для clean clone. Если нет make, эквивалентные documented scripts. Проверить healthcheck/startup ordering и readiness, а не sleep 30.

## Конфигурация
Создать .env.example с безопасными локальными значениями и комментариями:
DATABASE_URL; PUBLIC_APP_URL; CORS_ORIGINS;
AI_PROVIDER=ollama|openai_compatible; AI_BASE_URL; AI_API_KEY (пусто, server only); AI_MODEL;
EMBEDDING_PROVIDER; EMBEDDING_BASE_URL; EMBEDDING_API_KEY; EMBEDDING_MODEL;
OSM_SOURCE_URL; COVERAGE_CONFIG; INGEST_CONTACT_USER_AGENT;
ROUTING_PROVIDER=none|valhalla; ROUTING_BASE_URL;
LOG_LEVEL; REQUEST_TIMEOUT_SECONDS; RATE_LIMIT; DATA_DIR.
Не создавай фиктивный «бесплатный API key». Для стандартного локального map профиля MAP_API_KEY не нужен. Публичные настройки отделены от private. AI_BASE_URL/источник не должны задаваться пользователем из query и приводить к SSRF.

## Версии/CI/deploy
Зафиксируй reproducible dependency versions и официальные model identifiers после проверки. CI jobs: backend, frontend, E2E deterministic, secret/dependency checks. Live smoke отдельный gated job без публикации секретов и необязательный для чужих forks; локально должен быть проверен перед DONE. Недоступность CI runner не превращает local test в remote PASS.

Подготовь deployment.md: требования RAM/disk/CPU, volumes/db backups, reverse proxy/TLS, readiness, update migrations, rollback, models и пределы покрытия. Не делай публичный deploy, push в чужой репозиторий, DNS, billing или permissions сам. Локальный commit допустим; push только когда пользователь отдельно разрешил и target проверен.

## Отчёты
STATUS.md: этап, commit, что реально готово, какие agents/branches active, проверки, blockers, timestamp.
NEXT_STEPS.md: 3–7 точных последующих действий, команды, незавершённые процессы, опасности повторного запуска.
docs/VERIFICATION.md: requirement_id | status | test/command | environment/provider/dataset | exit code | evidence path.
docs/FINAL_REPORT.md: features, запуск, actual tests, actual dataset stats, источники, live/provider status, known P2/P3, limitations, optional configuration, демонстрация.

## Разрешённая остановка
- DONE: обязательные критерии подтверждены.
- BLOCKED: после разумной диагностики и выполнения независимой работы нужны доступ/ресурсы/ключ/решение. Сообщить точный blocker и минимальное действие пользователя, checkpoint сохранён.
- SESSION_LIMIT: сохранить состояние, не обходить квоту и не заявлять продолжающуюся фоновую работу без фактической работающей задачи. RESUME_PROMPT позволяет продолжить, но не гарантирует, что облачная сессия вечна.
