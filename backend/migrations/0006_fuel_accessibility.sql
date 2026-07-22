CREATE TABLE IF NOT EXISTS fuel_accessibility_profiles (
  station_id TEXT PRIMARY KEY REFERENCES fuel_stations(station_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES fuel_sources(source_id),
  external_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  rating REAL,
  assessment TEXT,
  assessed_at TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL DEFAULT '{}',
  photo_count INTEGER NOT NULL DEFAULT 0,
  attribution TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fuel_accessibility_source_record
  ON fuel_accessibility_profiles(source_id,external_id);
CREATE INDEX IF NOT EXISTS idx_fuel_accessibility_assessed
  ON fuel_accessibility_profiles(assessed_at DESC);

INSERT OR IGNORE INTO fuel_sources(
  source_id,name,source_type,base_url,reliability,usage_permission,enabled,created_at,updated_at
) VALUES(
  'data-gov-ua-barrier-free','Ministry / LUN barrier-free open data','official_open_data',
  'https://data.gov.ua/dataset/38997a1f-2e86-4bd7-9054-cd9cd206d825',
  0.92,'open_license',1,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
);
