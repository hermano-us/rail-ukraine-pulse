ALTER TABLE intelligence_cycles ADD COLUMN routes_calculated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE intelligence_cycles ADD COLUMN links_created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE intelligence_cycles ADD COLUMN calibration_profiles INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS rail_route_cache (
  cache_id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES rail_graph_versions(version_id),
  from_station_id TEXT NOT NULL REFERENCES station_registry(station_id),
  to_station_id TEXT NOT NULL REFERENCES station_registry(station_id),
  path_json TEXT,
  geometry_json TEXT,
  distance_km REAL,
  hop_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ready',
  geometry_quality REAL NOT NULL DEFAULT 0,
  calculated_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rail_route_cache_pair ON rail_route_cache(version_id,from_station_id,to_station_id);
CREATE INDEX IF NOT EXISTS idx_rail_route_cache_usage ON rail_route_cache(version_id,status,last_used_at DESC);

CREATE TABLE IF NOT EXISTS observation_run_links (
  event_id TEXT PRIMARY KEY REFERENCES events(event_id),
  original_run_id TEXT NOT NULL,
  canonical_run_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  confidence REAL NOT NULL DEFAULT 0,
  method TEXT NOT NULL,
  candidates_json TEXT,
  reason_json TEXT,
  linked_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_observation_run_links_canonical ON observation_run_links(canonical_run_id,status,updated_at DESC);

CREATE TABLE IF NOT EXISTS model_calibration_profiles (
  profile_id TEXT PRIMARY KEY,
  train_family TEXT NOT NULL,
  from_station_id TEXT NOT NULL,
  to_station_id TEXT NOT NULL,
  evaluation_count INTEGER NOT NULL DEFAULT 0,
  prospective_count INTEGER NOT NULL DEFAULT 0,
  mae_minutes REAL,
  p80_coverage REAL,
  residual_p10_minutes REAL,
  residual_p50_minutes REAL,
  residual_p90_minutes REAL,
  readiness TEXT NOT NULL DEFAULT 'insufficient-evidence',
  window_started_at TEXT,
  window_ended_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calibration_profiles_ready ON model_calibration_profiles(readiness,evaluation_count DESC);
