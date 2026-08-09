CREATE TABLE IF NOT EXISTS station_collection_plan (
  station_id TEXT PRIMARY KEY,
  station_name TEXT NOT NULL,
  priority_tier TEXT NOT NULL,
  priority_score REAL NOT NULL,
  target_interval_minutes INTEGER NOT NULL,
  request_weight INTEGER NOT NULL DEFAULT 1,
  reason_json TEXT NOT NULL DEFAULT '[]',
  calculated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_station_collection_due
  ON station_collection_plan(priority_tier, target_interval_minutes, priority_score DESC);

CREATE TABLE IF NOT EXISTS rail_graph_gaps (
  gap_id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES rail_graph_versions(version_id),
  from_station_id TEXT NOT NULL,
  to_station_id TEXT NOT NULL,
  distance_km REAL,
  from_component INTEGER,
  to_component INTEGER,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  detected_at TEXT NOT NULL,
  last_checked_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_rail_graph_gaps_open
  ON rail_graph_gaps(version_id, status, severity, distance_km);

CREATE TABLE IF NOT EXISTS rail_graph_gap_scans (
  version_id TEXT PRIMARY KEY REFERENCES rail_graph_versions(version_id),
  components INTEGER NOT NULL,
  candidates INTEGER NOT NULL,
  scanned_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS twin_probability_history (
  sample_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  hypothesis_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  probability REAL NOT NULL,
  progress_p10 REAL NOT NULL,
  progress_p50 REAL NOT NULL,
  progress_p90 REAL NOT NULL,
  latitude REAL,
  longitude REAL,
  confidence REAL NOT NULL,
  uncertainty_km REAL,
  sampled_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_probability_history_run
  ON twin_probability_history(run_id, sampled_at DESC);

CREATE TABLE IF NOT EXISTS model_releases (
  model_version TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  rollout_percent INTEGER NOT NULL DEFAULT 0,
  fallback_version TEXT,
  minimum_samples INTEGER NOT NULL DEFAULT 40,
  activated_at TEXT,
  evaluated_at TEXT,
  rolled_back_at TEXT,
  rollback_reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_release_active
  ON model_releases(status) WHERE status='active';

CREATE TABLE IF NOT EXISTS model_quality_windows (
  window_id TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  sample_count INTEGER NOT NULL,
  mae_minutes REAL,
  p80_coverage REAL,
  baseline_mae_minutes REAL,
  baseline_p80_coverage REAL,
  decision TEXT NOT NULL,
  reason TEXT,
  window_started_at TEXT,
  window_ended_at TEXT,
  evaluated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_quality_windows
  ON model_quality_windows(model_version, evaluated_at DESC);

INSERT OR IGNORE INTO model_releases(model_version,status,rollout_percent,fallback_version,minimum_samples,activated_at,metadata_json)
VALUES('rail-intelligence-v4','stable',0,NULL,40,NULL,'{"role":"automatic-fallback"}');
INSERT OR IGNORE INTO model_releases(model_version,status,rollout_percent,fallback_version,minimum_samples,activated_at,metadata_json)
VALUES('rail-intelligence-v5','active',100,'rail-intelligence-v4',40,datetime('now'),'{"role":"production"}');
