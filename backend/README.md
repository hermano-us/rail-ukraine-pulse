# Rail Ukraine Pulse backend

Cloudflare Worker хранит нормализованные рейсы и события в D1, держит быстрый снимок в KV, отдаёт API, статическую карту и закрытую диагностику.

Endpoints:

- GET /api/v1/snapshot — активный публичный снимок;
- GET /api/v1/events — журнал событий;
- GET /api/health — агрегированное состояние;
- POST /api/v1/ingest — приём данных по INGEST_TOKEN;
- GET /api/admin/overview — закрытая диагностика по ADMIN_TOKEN;
- /admin.html — интерфейс диагностики.

Production-конфигурация: wrangler.production.jsonc. Полный порядок запуска описан в docs/AUTONOMOUS_DEPLOYMENT.md.