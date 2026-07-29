CREATE TABLE IF NOT EXISTS station_poll_health (
  collector_id TEXT NOT NULL,
  station_id TEXT NOT NULL,
  station_name TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  records_total INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_success_at TEXT,
  cooldown_until TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(collector_id, station_id)
);
CREATE INDEX IF NOT EXISTS idx_station_poll_health_station
  ON station_poll_health(station_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS trusted_collector_registry (
  collector_id TEXT PRIMARY KEY,
  version TEXT,
  status TEXT NOT NULL,
  request_budget INTEGER NOT NULL DEFAULT 1,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_station_id TEXT,
  last_station_name TEXT,
  last_heartbeat_at TEXT NOT NULL,
  last_success_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_trusted_collectors_health
  ON trusted_collector_registry(status, last_heartbeat_at DESC);

ALTER TABLE station_coverage_priorities ADD COLUMN priority_tier TEXT NOT NULL DEFAULT 'background';
ALTER TABLE station_coverage_priorities ADD COLUMN collector_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE station_coverage_priorities ADD COLUMN next_eligible_at TEXT;

ALTER TABLE observation_fusion_groups ADD COLUMN source_domains INTEGER NOT NULL DEFAULT 0;
ALTER TABLE observation_fusion_groups ADD COLUMN temporal_spread_minutes REAL;
ALTER TABLE observation_fusion_groups ADD COLUMN negative_evidence_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS model_calibration_profiles_v4 (
  profile_id TEXT PRIMARY KEY,
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
CREATE INDEX IF NOT EXISTS idx_calibration_v4_readiness
  ON model_calibration_profiles_v4(readiness, prospective_count DESC, evaluation_count DESC);

ALTER TABLE intelligence_cycles ADD COLUMN active_collectors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE intelligence_cycles ADD COLUMN reliability_urgent_stations INTEGER NOT NULL DEFAULT 0;
