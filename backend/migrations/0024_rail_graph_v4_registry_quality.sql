ALTER TABLE expected_train_runs ADD COLUMN operational_status TEXT NOT NULL DEFAULT 'planned';
ALTER TABLE expected_train_runs ADD COLUMN operational_reason TEXT;
ALTER TABLE expected_train_runs ADD COLUMN state_changed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_expected_runs_operational
  ON expected_train_runs(service_date, operational_status, train_number);

CREATE TABLE IF NOT EXISTS rail_route_rebuild_queue (
  queue_id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES rail_graph_versions(version_id),
  from_station_id TEXT NOT NULL,
  to_station_id TEXT NOT NULL,
  run_id TEXT,
  priority INTEGER NOT NULL DEFAULT 50,
  reason TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  processed_at TEXT,
  result TEXT,
  error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_route_rebuild_open_pair
  ON rail_route_rebuild_queue(version_id, from_station_id, to_station_id)
  WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_route_rebuild_pending
  ON rail_route_rebuild_queue(processed_at, priority DESC, queued_at);

CREATE TABLE IF NOT EXISTS model_calibration_profiles_v5 (
  profile_id TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  dimension_type TEXT NOT NULL,
  dimension_key TEXT NOT NULL,
  source_id TEXT,
  train_family TEXT,
  from_station_id TEXT,
  to_station_id TEXT,
  time_bucket TEXT,
  horizon_bucket TEXT,
  evaluation_count INTEGER NOT NULL DEFAULT 0,
  prospective_count INTEGER NOT NULL DEFAULT 0,
  mae_minutes REAL,
  p80_coverage REAL,
  bias_minutes REAL,
  residual_p10_minutes REAL,
  residual_p50_minutes REAL,
  residual_p90_minutes REAL,
  uncertainty_multiplier REAL NOT NULL DEFAULT 1,
  readiness TEXT NOT NULL DEFAULT 'insufficient-evidence',
  window_started_at TEXT,
  window_ended_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_v5_dimension
  ON model_calibration_profiles_v5(model_version, dimension_type, dimension_key);
CREATE INDEX IF NOT EXISTS idx_calibration_v5_readiness
  ON model_calibration_profiles_v5(model_version, readiness, prospective_count DESC);

ALTER TABLE intelligence_cycles ADD COLUMN routes_rebuilt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE intelligence_cycles ADD COLUMN graph_version TEXT;
