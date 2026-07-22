CREATE TABLE IF NOT EXISTS fuel_sources (
  source_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  base_url TEXT,
  reliability REAL NOT NULL DEFAULT 0.5 CHECK(reliability BETWEEN 0 AND 1),
  usage_permission TEXT NOT NULL CHECK(usage_permission IN ('open_license','official_api','partner_feed','manual_reference_only','unknown','prohibited')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fuel_stations (
  station_id TEXT PRIMARY KEY,
  canonical_name TEXT,
  brand TEXT,
  operator_name TEXT,
  latitude REAL NOT NULL CHECK(latitude BETWEEN 44 AND 53),
  longitude REAL NOT NULL CHECK(longitude BETWEEN 21 AND 41),
  geohash6 TEXT,
  geohash8 TEXT,
  region_code TEXT,
  city TEXT,
  address TEXT,
  opening_hours TEXT,
  phone TEXT,
  website TEXT,
  payment_cards INTEGER,
  services_json TEXT NOT NULL DEFAULT '{}',
  catalog_confidence REAL NOT NULL DEFAULT 0 CHECK(catalog_confidence BETWEEN 0 AND 1),
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle_status IN ('active','review','missing','merged','closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fuel_stations_bbox ON fuel_stations(latitude,longitude);
CREATE INDEX IF NOT EXISTS idx_fuel_stations_geohash6 ON fuel_stations(geohash6);
CREATE INDEX IF NOT EXISTS idx_fuel_stations_brand ON fuel_stations(brand);
CREATE INDEX IF NOT EXISTS idx_fuel_stations_region ON fuel_stations(region_code);

CREATE TABLE IF NOT EXISTS fuel_station_source_records (
  record_id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES fuel_stations(station_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES fuel_sources(source_id),
  external_id TEXT NOT NULL,
  external_url TEXT,
  source_type TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  name TEXT,
  brand TEXT,
  address TEXT,
  raw_payload_json TEXT NOT NULL,
  license_type TEXT,
  usage_permission TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_checked_at TEXT NOT NULL,
  match_score REAL NOT NULL DEFAULT 0 CHECK(match_score BETWEEN 0 AND 1),
  match_status TEXT NOT NULL CHECK(match_status IN ('matched','possible_match','duplicate_candidate','new_station_candidate','rejected','manual_review')),
  match_reasons_json TEXT NOT NULL DEFAULT '[]',
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_id,external_id)
);
CREATE INDEX IF NOT EXISTS idx_fuel_source_records_station ON fuel_station_source_records(station_id);
CREATE INDEX IF NOT EXISTS idx_fuel_source_records_review ON fuel_station_source_records(match_status,updated_at DESC);

CREATE TABLE IF NOT EXISTS fuel_station_merge_history (
  merge_id TEXT PRIMARY KEY,
  source_station_id TEXT NOT NULL,
  target_station_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('merge','unmerge')),
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reversible_snapshot_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fuel_merge_time ON fuel_station_merge_history(occurred_at DESC);

CREATE TABLE IF NOT EXISTS fuel_status_observations (
  observation_id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES fuel_stations(station_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('operating','partially_operating','temporarily_closed','closed','fuel_unavailable','damaged_reported','unknown')),
  public_reason TEXT,
  private_reason TEXT,
  observed_at TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  expires_at TEXT,
  source_id TEXT,
  source_type TEXT NOT NULL,
  user_id TEXT,
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  moderation_status TEXT NOT NULL CHECK(moderation_status IN ('pending','approved','rejected','superseded')),
  evidence_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_fuel_status_station_time ON fuel_status_observations(station_id,observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fuel_status_moderation ON fuel_status_observations(moderation_status,submitted_at DESC);

CREATE TABLE IF NOT EXISTS fuel_availability_observations (
  observation_id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES fuel_stations(station_id) ON DELETE CASCADE,
  fuel_type TEXT NOT NULL CHECK(fuel_type IN ('a92','a95','a95_premium','a98','a100','diesel','diesel_premium','lpg','adblue','electric_charging','other')),
  availability TEXT NOT NULL CHECK(availability IN ('available','low_availability','unavailable','unknown')),
  observed_at TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  expires_at TEXT,
  source_id TEXT,
  source_type TEXT NOT NULL,
  user_id TEXT,
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  moderation_status TEXT NOT NULL CHECK(moderation_status IN ('pending','approved','rejected','superseded'))
);
CREATE INDEX IF NOT EXISTS idx_fuel_availability_station_time ON fuel_availability_observations(station_id,fuel_type,observed_at DESC);

CREATE TABLE IF NOT EXISTS fuel_price_observations (
  observation_id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES fuel_stations(station_id) ON DELETE CASCADE,
  fuel_type TEXT NOT NULL,
  price_minor INTEGER NOT NULL CHECK(price_minor > 0),
  currency TEXT NOT NULL DEFAULT 'UAH',
  observed_at TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  expires_at TEXT,
  source_id TEXT,
  source_type TEXT NOT NULL,
  user_id TEXT,
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  official INTEGER NOT NULL DEFAULT 0 CHECK(official IN (0,1)),
  moderation_status TEXT NOT NULL CHECK(moderation_status IN ('pending','approved','rejected','superseded'))
);
CREATE INDEX IF NOT EXISTS idx_fuel_price_station_time ON fuel_price_observations(station_id,fuel_type,observed_at DESC);

CREATE TABLE IF NOT EXISTS fuel_current_state (
  station_id TEXT PRIMARY KEY REFERENCES fuel_stations(station_id) ON DELETE CASCADE,
  public_status TEXT NOT NULL DEFAULT 'unknown',
  status_confidence REAL NOT NULL DEFAULT 0,
  status_verified_at TEXT,
  status_expires_at TEXT,
  conflict_state TEXT NOT NULL DEFAULT 'none',
  fuel_json TEXT NOT NULL DEFAULT '{}',
  prices_json TEXT NOT NULL DEFAULT '{}',
  queue_state TEXT NOT NULL DEFAULT 'unknown',
  payment_json TEXT NOT NULL DEFAULT '{}',
  resolved_at TEXT NOT NULL,
  resolver_version TEXT NOT NULL,
  evidence_summary_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_fuel_current_status ON fuel_current_state(public_status,status_expires_at);

CREATE TABLE IF NOT EXISTS fuel_reports (
  report_id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES fuel_stations(station_id) ON DELETE CASCADE,
  user_id TEXT,
  report_type TEXT NOT NULL,
  fuel_type TEXT,
  price_minor INTEGER,
  note TEXT,
  observed_at TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  moderation_status TEXT NOT NULL DEFAULT 'pending',
  confidence REAL NOT NULL DEFAULT 0,
  client_fingerprint_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fuel_reports_queue ON fuel_reports(moderation_status,submitted_at DESC);

CREATE TABLE IF NOT EXISTS fuel_moderation_queue (
  queue_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  station_id TEXT,
  priority INTEGER NOT NULL DEFAULT 50,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','assigned','resolved','rejected')),
  assigned_to TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_fuel_moderation_open ON fuel_moderation_queue(status,priority DESC,created_at);

CREATE TABLE IF NOT EXISTS fuel_audit_log (
  audit_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fuel_audit_time ON fuel_audit_log(occurred_at DESC);

CREATE TABLE IF NOT EXISTS fuel_import_runs (
  import_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  received_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_fuel_import_time ON fuel_import_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS fuel_source_health_checks (
  check_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  records_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_fuel_source_health_time ON fuel_source_health_checks(source_id,checked_at DESC);

INSERT OR IGNORE INTO fuel_sources(
  source_id,name,source_type,base_url,reliability,usage_permission,enabled,created_at,updated_at
) VALUES(
  'openstreetmap','OpenStreetMap','catalog','https://www.openstreetmap.org',0.82,'open_license',1,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
);
