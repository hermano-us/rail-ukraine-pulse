# Fuel Ukraine Pulse — архитектура модуля АЗС

Статус: проектирование MVP
Платформа: Rail Ukraine Pulse / Cloudflare
Дата решения: 2026-07-22

## 1. Решение

Модуль АЗС создаётся как отдельный bounded context общей транспортной платформы.

- Публичный интерфейс: `/fuel/`.
- Операторский интерфейс: `/fuel-ops/`.
- Публичный API: `/api/fuel/v1/*`.
- Административный API: `/api/fuel/admin/*`.
- Железнодорожные таблицы и API не изменяются.
- АЗС не отображаются на железнодорожной карте по умолчанию.
- Общими остаются deployment, аудит, мониторинг, темы интерфейса и базовая карта.

Основной backend: Cloudflare Workers + D1 + R2 + Cron Triggers.

Причины выбора:

1. Уже развёрнут и проверен в production.
2. Не требует отдельного постоянно работающего сервера.
3. D1 достаточно для каталога порядка 5–10 тысяч АЗС и истории MVP.
4. R2 подходит для модерируемых фотографий.
5. Workers позволяют централизованно разрешать конфликты и не отдавать сырые сообщения клиенту.
6. Cloudflare Access защищает операторский интерфейс.
7. Архитектура не зависит от GitHub Pages: Worker может обслуживать API и frontend самостоятельно.

Ограничение: D1 не является PostGIS. Для MVP используются geohash, bounding-box индексы и Haversine. При выходе за пределы 50–100 тысяч геообъектов репозиторий можно перенести на PostgreSQL/PostGIS без изменения публичных контрактов API.

## 2. Границы безопасности

Публичная система хранит только гражданскую информацию, необходимую водителю.

Запрещено собирать или публиковать:

- объёмы запасов;
- графики поставок;
- маршруты бензовозов;
- сведения о нефтебазах;
- специальные и военные объекты;
- точные оперативные детали повреждений;
- неподтверждённые причины закрытия.

Публичный статус `damaged_reported` преобразуется в нейтральное «Временно не работает» или «Работа временно не подтверждена». Исходная причина доступна только модератору и не публикуется автоматически.

Фотографии проходят удаление EXIF, MIME-проверку, антивирусную/форматную проверку и ручную модерацию. Публичный frontend никогда не получает исходные административные заметки.

## 3. Источники

### Подключаемые в MVP

- OpenStreetMap — базовый каталог, не оперативный статус.
- Ручной импорт администратора CSV/JSON.
- Модерируемые пользовательские сообщения.
- Официальные CSV/JSON/API сетей только при наличии разрешения.

### Только кандидаты

- официальные сайты без API;
- сторонние каталоги;
- публичные сообщения;
- прайс-агрегаторы.

Для кандидатов разрешены ссылка, ручная сверка и создание записи на проверку. Автоматическое копирование запрещено до проверки лицензии.

Каждый адаптер реализует единый контракт:

```text
fetch(cursor) -> SourceBatch
normalize(record) -> SourceRecord
validate(record) -> ValidationResult
licensePolicy(record) -> publish | review_only | prohibited
health() -> SourceHealth
```

Никакие API сетей не считаются существующими, пока интеграция не подтверждена документацией или владельцем.

## 4. Идентичность АЗС

Главный идентификатор — внутренний UUID `station_id`. OSM ID не используется как первичный ключ физической АЗС.

Одна станция может иметь несколько исходных записей:

```text
fuel_stations 1 ─── N fuel_station_source_records
```

Автоматическое сопоставление учитывает:

- расстояние;
- нормализованный бренд;
- адрес и населённый пункт;
- телефон;
- домен сайта;
- режим работы;
- номер дороги.

Близость координат сама по себе не является достаточным условием.

Статусы сопоставления:

- `matched`;
- `possible_match`;
- `duplicate_candidate`;
- `new_station_candidate`;
- `rejected`;
- `manual_review`.

Каждое решение сохраняет `match_score`, причины и автора. Объединение можно откатить.

## 5. Модель данных D1

### Каталог

`fuel_stations`

- station_id;
- canonical_name;
- brand_id;
- operator_name;
- latitude, longitude;
- geohash6, geohash8;
- region_code, city, address;
- opening_hours;
- phone, website;
- catalog_confidence;
- lifecycle_status;
- created_at, updated_at.

`fuel_station_source_records`

- record_id;
- station_id;
- source_id;
- external_id, external_url;
- source_type;
- latitude, longitude;
- name, brand, address;
- raw_payload_json;
- license_type;
- usage_permission;
- last_seen_at, last_checked_at;
- match_score, match_status, match_reasons_json;
- is_primary;
- created_at, updated_at.

`fuel_station_merge_history`

- merge_id;
- source_station_id;
- target_station_id;
- action;
- reason;
- actor_id;
- reversible_snapshot_json;
- occurred_at.

### Наблюдения

`fuel_status_observations`

- observation_id;
- station_id;
- status;
- public_reason;
- private_reason;
- observed_at, submitted_at, expires_at;
- source_id, source_type;
- user_id;
- confidence;
- moderation_status;
- evidence_json.

`fuel_availability_observations`

- observation_id;
- station_id;
- fuel_type;
- availability;
- observed_at, expires_at;
- source_id, user_id;
- confidence;
- moderation_status.

`fuel_price_observations`

- observation_id;
- station_id;
- fuel_type;
- price_minor;
- currency;
- observed_at, expires_at;
- source_id, user_id;
- confidence;
- official;
- moderation_status.

Точная оценка количества топлива отсутствует принципиально.

### Производная проекция

`fuel_current_state`

- station_id;
- public_status;
- status_confidence;
- status_verified_at;
- status_expires_at;
- conflict_state;
- fuel_json;
- prices_json;
- queue_state;
- payment_json;
- resolved_at;
- resolver_version;
- evidence_summary_json.

Frontend читает эту таблицу, а не вычисляет итоговый статус из сырых сообщений.

### Пользователи и модерация

- `fuel_users`;
- `fuel_user_roles`;
- `fuel_reputation_events`;
- `fuel_reports`;
- `fuel_report_media`;
- `fuel_moderation_queue`;
- `fuel_sources`;
- `fuel_source_health_checks`;
- `fuel_audit_log`;
- `fuel_import_runs`;
- `fuel_outbox_events`.

## 6. Сроки актуальности

| Факт | TTL |
|---|---:|
| Работает | 6 часов |
| Временно закрыта | 6 часов |
| Технический перерыв | 2 часа |
| Топливо доступно | 3 часа |
| Топливо отсутствует | 2 часа |
| Очередь | 1 час |
| Цена | 24 часа |
| Официальное закрытие | До нового официального события |
| Подтверждённое повреждение | До модерируемого сообщения о восстановлении |

После TTL запись не удаляется. Она остаётся в истории, а публичная проекция получает `stale` или `unknown`.

## 7. Confidence

Не смешиваются:

- `catalog_confidence` — существование, координаты, бренд и отсутствие дубля;
- `status_confidence` — текущая работа станции;
- `fuel_confidence` — доступность конкретного топлива;
- `price_confidence` — актуальность цены.

Базовые веса:

| Источник | Вес |
|---|---:|
| Официальный API/выгрузка | 1.00 |
| Официальное сообщение | 0.95 |
| Модератор | 0.90 |
| Представитель сети | 0.90 |
| Проверенный пользователь | 0.80 |
| Авторизованный пользователь | 0.60 |
| Анонимное сообщение | 0.35 |
| Автоматически извлечённый кандидат | 0.30 |

Расчёт:

```text
confidence =
  sourceReliability
  × freshnessFactor
  × consistencyFactor
  × moderationFactor
  + independentConfirmationBonus
```

Результат ограничивается диапазоном 0–1. Одиночное неподтверждённое сообщение с confidence ниже 0.40 не меняет основной статус.

При конфликте resolver публикует `conflicting`/«Информация противоречива» и создаёт задачу модерации.

## 8. API

Публичные методы:

- `GET /api/fuel/v1/stations?bbox=&zoom=&filters=`;
- `GET /api/fuel/v1/stations/:id`;
- `GET /api/fuel/v1/stations/:id/history`;
- `GET /api/fuel/v1/nearby?lat=&lng=&radius=`;
- `GET /api/fuel/v1/brands`;
- `POST /api/fuel/v1/reports`;
- `GET /api/fuel/v1/stream`.

Операторские методы:

- `GET /api/fuel/admin/queue`;
- `POST /api/fuel/admin/reports/:id/approve`;
- `POST /api/fuel/admin/reports/:id/reject`;
- `POST /api/fuel/admin/stations/:id/merge`;
- `POST /api/fuel/admin/stations/:id/unmerge`;
- `POST /api/fuel/admin/imports`;
- `GET /api/fuel/admin/audit`;
- `GET /api/fuel/admin/sources`.

Ответы публичного API содержат только производную проекцию, источники с разрешением на публикацию и объяснимую оценку доверия.

## 9. Авторизация

- Guest: только публичное чтение.
- User: отправка сообщения после входа и Turnstile.
- Verified user: повышенный вес после истории подтверждений.
- Moderator: очередь и решения.
- Administrator: источники, роли и конфигурация.
- Network representative: только станции разрешённой сети.

Для MVP административные роли защищаются Cloudflare Access и дополнительно проверяются Worker. Публичная пользовательская авторизация проектируется через OAuth/OIDC; секреты хранятся в Worker Secrets. D1 не имеет RLS, поэтому эквивалентные ограничения реализуются в repository/service layer и проверяются integration-тестами.

## 10. Автоматизация

- Cron каждые 5 минут: пересчёт истёкших статусов и outbox.
- Cron каждые 15 минут: health-check подключённых оперативных источников.
- Раз в сутки: импорт каталога OSM.
- Queue: нормализация, дедупликация, модерационные события.
- R2: исходные и очищенные медиа с разными правами доступа.
- D1 backup: существующий workflow расширяется таблицами `fuel_*`.
- Production monitor: отдельные readiness-метрики rail и fuel.

Полный импорт OSM не выполняется браузером. Для MVP он запускается из изолированного collector job; Worker получает уже нормализованные пачки.

## 11. Frontend

Маршрут `/fuel/` получает собственные ES-модули:

```text
fuel/
  index.html
  css/
  js/
    app.js
    api-client.js
    data-store.js
    freshness.js
    confidence.js
    map/
    ui/
```

Обязательные режимы:

- кластерная карта;
- список ближайших АЗС;
- поиск и bbox-загрузка;
- карточка с источником, freshness и confidence;
- фильтры топлива, цены, сети, времени подтверждения;
- light/dark;
- PWA offline snapshot с явной датой;
- навигационные ссылки;
- форма сообщения по уже выбранной станции.

Клиент не загружает всю историю и не разрешает конфликты самостоятельно.

## 12. Наблюдаемость

Operations Center получает отдельную вкладку Fuel:

- возраст каталога OSM;
- количество станций и source records;
- каталог без сопоставления;
- возможные дубли;
- открытые конфликты;
- сообщения в очереди;
- доля устаревших статусов;
- health источников;
- длительность import/resolver;
- audit log.

SLO MVP:

- публичный snapshot не старше 15 минут;
- каталог OSM не старше 48 часов;
- p95 API чтения до 500 мс;
- ни один неподтверждённый report не публикуется автоматически как факт.

## 13. Этапы

1. Миграции D1, доменные типы и unit-тесты.
2. OSM importer и мульти-источниковый каталог.
3. Public stations API с bbox/nearby.
4. Карта, кластеризация, карточка и фильтры.
5. Auth, reports, Turnstile и moderation queue.
6. CurrentStatusResolver и conflict engine.
7. Топливо, цены и история.
8. Fuel Operations Center.
9. PWA, accessibility, E2E и production rollout.

Каждый этап разворачивается независимо и не меняет железнодорожные API.

## 14. Риски

- Неполнота OSM: компенсируется source records и очередью кандидатов.
- Запрет scraping: только разрешённые API/выгрузки; остальные review-only.
- Ложные сообщения: auth, Turnstile, rate limit, репутация и модерация.
- Старые данные: TTL и явный unknown вместо ложного статуса.
- Дубли: внутренний station_id, match score и reversible merge.
- Большой импорт: server-side collector, пачки и idempotent upsert.
- Отсутствие PostGIS: geohash/bbox MVP, миграционный контракт на PostGIS.
- Чувствительные данные: отдельные private/public поля и deny-by-default.
- Зависимость от одного источника: независимые adapters и health history.

## 15. Критерий перехода к реализации

Архитектура считается утверждённой, если согласованы:

- Cloudflare как основной backend;
- отдельный URL `/fuel/`;
- OSM как базовый, но не единственный каталог;
- обязательная модерация пользовательских сообщений;
- отсутствие данных о запасах и поставках;
- раздельные catalog/status/fuel/price confidence;
- отсутствие scraping без разрешения;
- поэтапный rollout без демонстрационных публичных данных.
