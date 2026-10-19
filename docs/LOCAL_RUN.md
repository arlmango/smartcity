# Как открыть SmartCity на своём компьютере

Сайт запускается только у вас локально: адрес http://localhost:3000 доступен лишь с этого компьютера,
ничего не публикуется в интернет.

## Что нужно
| | Минимум | Комфортно |
|---|---|---|
| Память (RAM) | 8 ГБ | 16 ГБ |
| Свободный диск | 10 ГБ | 15 ГБ |
| Процессор | 4 ядра | 8 ядер или GPU (ответ ИИ быстрее) |

Программы (бесплатные):
1. **Docker Desktop** — https://www.docker.com/products/docker-desktop/ (на Linux: Docker Engine + Compose).
2. **Git** — https://git-scm.com/downloads
3. **uv** (менеджер Python) — https://docs.astral.sh/uv/getting-started/installation/
   - macOS / Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`
4. **make** — на macOS: `xcode-select --install`; на Ubuntu: `sudo apt install make`.

**Windows:** установите WSL2 с Ubuntu (`wsl --install` в PowerShell от администратора), включите в Docker Desktop
интеграцию с WSL (Settings → Resources → WSL integration) и выполняйте все команды ниже в терминале Ubuntu.

## Запуск (один раз ~15–25 минут, в основном загрузка моделей)
Откройте терминал и выполните по очереди:

```bash
git clone -b claude/wizardly-bardeen-py0dnc https://github.com/arlmango/smartcity.git
cd smartcity
make bootstrap                 # настройки .env, зависимости Python, база данных
CONFIRM=1 make models          # локальные модели ИИ: ~3.1 ГБ (qwen2.5:3b и bge-m3)
make ingest ARGS="--from-snapshot osm-20261018T200514Z"   # данные OSM из сохранённого в репозитории снимка
make index                     # смысловой индекс мест
make up                        # запуск сайта, ждёт готовности всех сервисов
```

Затем откройте в браузере: **http://localhost:3000**

- `make ingest` с `--from-snapshot` работает без интернета (снимок OpenStreetMap лежит в `data/snapshots/`).
  Чтобы скачать свежие данные из OpenStreetMap: `make ingest` (публичный сервер Overpass иногда отвечает 504 —
  тогда выполните `make ingest ARGS="--retry-failed <имя снимка из сообщения>"`).
- Проверка, что всё готово: `curl http://localhost:8000/api/ready` — у db, data, map, embeddings, llm должно быть `ok`.

## Как пользоваться
1. Выберите точку: кликните по карте, найдите место в поле «Найти место в нашей базе» (например, «Mega») или нажмите
   «Демо-точка». Геолокация запрашивается только по кнопке «Моё местоположение».
2. Напишите, чего хочется, выберите время и «Вернуться сюда».
3. «Подобрать прогулку». Найденные места появятся через несколько секунд с пометкой «ИИ готовит объяснения…»;
   объяснения ИИ на обычном процессоре приходят через 30–90 секунд (первый запрос после запуска — дольше, модель
   загружается в память). Если ИИ не успеет, найденные места останутся на экране.

## Остановка и повторный запуск
```bash
make down      # остановить (данные и модели сохраняются)
make up        # снова запустить
```

## Если что-то не так
| Симптом | Что сделать |
|---|---|
| `make doctor` показывает занятые порты 3000 / 8000 / 5433 / 11434 | закройте программу, занимающую порт, или задайте `WEB_PORT`, `API_PORT`, `DB_PORT` в `.env` |
| «ИИ временно недоступен» | `docker compose ps` — контейнер `ollama` должен быть `healthy`; проверьте `make models` |
| Карта пустая, «API недоступен» | `make up`, затем `curl http://localhost:8000/api/ready` |
| Мало памяти, всё медленно | закройте тяжёлые программы; ответы ИИ на CPU занимают до 1,5 минут |

Подробнее: [README.md](../README.md), [deployment.md](deployment.md), [PRIVACY.md](PRIVACY.md).
