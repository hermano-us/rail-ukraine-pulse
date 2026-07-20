# Автономное развёртывание

Проект теперь разделён на три независимых контура:

1. Collector читает публичные источники, нормализует события и каждые 3 минуты отправляет снимок в API.
2. Cloudflare Worker хранит рейсы и события в D1/KV, отдаёт API и статические файлы карты.
3. Cloudflare Access управляет доступом зрителей по email/одноразовому коду без хранения паролей в проекте.

GitHub Pages и GitHub Actions остаются резервным каналом до переключения домена, но не требуются для работы контейнерного сборщика.

## Сборщик на VPS или домашнем сервере

Требования: Docker Compose и постоянный исходящий HTTPS-доступ.

Создайте файл .env рядом с compose-файлом:

    RAIL_API_URL=https://rail-ukraine-pulse-api.example.workers.dev
    RAIL_INGEST_TOKEN=отдельный_случайный_секрет_не_короче_24_символов
    COLLECTOR_INTERVAL_MS=180000
    BOARD_HEADLESS=true

Запуск:

    docker compose -f compose.collector.yaml up -d --build
    docker compose -f compose.collector.yaml ps

Healthcheck внутри контейнера доступен на http://127.0.0.1:8080/health. Циклы не накладываются: следующий начинается через заданный интервал после завершения предыдущего.

## Публикация карты и API в Cloudflare

Workflow Deploy autonomous Cloudflare application запускается вручную. До запуска добавьте GitHub Secrets:

- CLOUDFLARE_API_TOKEN
- CLOUDFLARE_ACCOUNT_ID
- RAIL_INGEST_TOKEN
- RAIL_ADMIN_TOKEN

RAIL_INGEST_TOKEN должен совпадать у Worker и collector. RAIL_ADMIN_TOKEN используется только страницей /admin.html.

Статические assets раздаются непосредственно Cloudflare, а пути /api/* обрабатывает Worker. Конфигурация находится в backend/wrangler.production.jsonc.

## Доступ пользователей

Для выдачи и отзыва доступа рекомендуется Cloudflare Zero Trust → Access → Applications → Self-hosted. Политика по конкретным email даёт:

- вход по одноразовому коду или через выбранный identity provider;
- мгновенный отзыв доступа;
- журнал входов;
- отсутствие собственной базы паролей и рисков восстановления учётных данных.

Можно защитить весь Worker или отдельный hostname. Админ-диагностика дополнительно требует RAIL_ADMIN_TOKEN, даже если пользователь уже прошёл внешний Access.

Официальная документация:

- https://developers.cloudflare.com/workers/static-assets/binding/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/choose-application-type/

## Миграция без простоя

1. Развернуть новую версию Worker вручную.
2. Запустить collector и убедиться, что /health показывает healthy.
3. Проверить /api/health, карту и /admin.html.
4. Подключить домен и Access.
5. Только после нескольких успешных циклов отключить GitHub schedule.