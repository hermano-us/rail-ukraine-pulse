# Rail Ukraine Pulse Worker

Cloudflare Worker публикует карту, хранит события в D1, текущий снимок в KV и контролирует свежесть контура.

## Маршруты

- `GET /api/health` — публичный health с честным статусом `ok`, `degraded` или `unavailable`;
- `GET /api/v1/snapshot` — текущий публичный снимок;
- `GET /api/v1/stream` — SSE-сигнал о версии снимка, переподключение каждые 10 секунд;
- `GET /api/v1/events` — журнал событий;
- `POST /api/v1/ingest` — приём данных по `INGEST_TOKEN`;
- `GET /api/admin/overview` — закрытая диагностика по `ADMIN_TOKEN`;
- `GET /rail-ops` — кастомный Operations Center;
- `/admin.html` намеренно возвращает `404`.

Cron Worker запускается каждые пять минут. Если внешний upstream не задан, Cron только измеряет свежесть текущего снимка и не меняет его время, поэтому старые данные не выглядят новыми.
