CREATE TABLE IF NOT EXISTS fuel_incident_signals (
  signal_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,
  snippet TEXT,
  published_at TEXT,
  detected_at TEXT NOT NULL,
  incident_type TEXT NOT NULL CHECK(incident_type IN ('possible_damage','possible_closure','possible_reopening','status_report','unknown')),
  location_text TEXT,
  latitude REAL,
  longitude REAL,
  matched_station_id TEXT REFERENCES fuel_stations(station_id) ON DELETE SET NULL,
  match_distance_km REAL,
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  moderation_status TEXT NOT NULL DEFAULT 'pending' CHECK(moderation_status IN ('pending','approved','rejected')),
  raw_payload_json TEXT NOT NULL DEFAULT '{}',
  reviewed_at TEXT,
  reviewed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_fuel_incident_moderation ON fuel_incident_signals(moderation_status,detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_fuel_incident_station ON fuel_incident_signals(matched_station_id,detected_at DESC);
