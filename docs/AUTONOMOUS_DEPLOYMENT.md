# Автономное развёртывание

Проект состоит из трёх независимых контуров:

1. Collector читает публичные источники, нормализует события и отправляет снимок в API. GitHub Actions делает это каждые 10 минут; Docker-версия может работать каждые 3 минуты на отдельном сервере.
2. Cloudflare Worker постоянно доступен по запросу, хранит рейсы и события в D1/KV, публикует карту и каждые 5 минут проверяет свежесть данных.
3. Operations Center по адресу `/rail-ops` показывает состояние pipeline, возраст снимка, источники и последние события. API панели дополнительно защищён `RAIL_ADMIN_TOKEN`.

## Постоянный collector

Создайте `.env` рядом с compose-файлом:

```dotenv
RAIL_API_URL=https://rail-ukraine-pulse-api.example.workers.dev
RAIL_INGEST_TOKEN=отдельный_случайный_секрет_не_короче_24_символов
COLLECTOR_INTERVAL_MS=180000
COLLECTOR_ATTEMPTS=3
COLLECTOR_SCRIPT_TIMEOUT_MS=480000
BOARD_HEADLESS=true
```

Запуск:

```bash
docker compose -f compose.collector.yaml up -d --build
docker compose -f compose.collector.yaml ps
```

`/health` и `/ready` возвращают `503`, если успешного цикла ещё не было или последний успех старше трёх интервалов (минимум 15 минут). Циклы не накладываются; каждый получает до трёх попыток и ограничен таймаутом.

## Cloudflare

GitHub workflow `Deploy autonomous Cloudflare application` требует секреты:

- `CLOUDFLARE_API_TOKEN`;
- `CLOUDFLARE_ACCOUNT_ID`;
- `RAIL_INGEST_TOKEN`;
- `RAIL_ADMIN_TOKEN`.

Production-конфигурация находится в `backend/wrangler.production.jsonc`. Она включает D1, KV, static assets и Cron `*/5 * * * *`.

## Cloudflare Access

Код готов к защите Operations Center через Cloudflare Access, но policy нельзя безопасно создать без списка разрешённых email. Настройка:

1. Cloudflare Zero Trust → Access → Applications → Add application → Self-hosted.
2. Domain: hostname Worker, Path: `rail-ops*`.
3. Session duration: 8 hours.
4. Allow policy: только выбранные email или email domain.
5. Оставить `RAIL_ADMIN_TOKEN` вторым фактором защиты API.

Для автоматизации через API deployment-токену понадобится отдельное разрешение `Access: Apps and Policies Write`. Не защищайте весь hostname, иначе будет закрыта публичная карта и `/api/v1/snapshot`.

## Мониторинг

- Worker health: `/api/health`;
- Operations Center: `/rail-ops`;
- Collector readiness: `/ready`;
- GitHub incident: один issue `[monitor] Public data refresh is failing`, обновляемый при повторных падениях и закрываемый после восстановления;
- SSE: `/api/v1/stream`, резервный polling карты — 60 секунд.

Система работает автономно, но «реальное время» ограничено скоростью публичных источников. SSE уменьшает задержку между появлением нового снимка в API и отображением на карте, не подменяя GPS-телеметрию.
