ALTER TABLE rail_graph_import_state ADD COLUMN first_attempt_at TEXT;
ALTER TABLE rail_graph_import_state ADD COLUMN last_progress_at TEXT;
ALTER TABLE rail_graph_import_state ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rail_graph_import_state ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rail_graph_import_state ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rail_graph_import_state ADD COLUMN estimated_completion_at TEXT;

CREATE TABLE IF NOT EXISTS rail_graph_diagnostics (
  version_id TEXT PRIMARY KEY REFERENCES rail_graph_versions(version_id),
  health_status TEXT NOT NULL,
  connected_components INTEGER NOT NULL DEFAULT 0,
  largest_component_nodes INTEGER NOT NULL DEFAULT 0,
  topology_nodes INTEGER NOT NULL DEFAULT 0,
  isolated_stations INTEGER NOT NULL DEFAULT 0,
  terminal_nodes INTEGER NOT NULL DEFAULT 0,
  anomalous_segments INTEGER NOT NULL DEFAULT 0,
  maximum_segment_km REAL,
  details_json TEXT,
  calculated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS station_codes (
  code_type TEXT NOT NULL,
  code_value TEXT NOT NULL,
  station_id TEXT NOT NULL REFERENCES station_registry(station_id),
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  verified INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(code_type, code_value)
);
CREATE INDEX IF NOT EXISTS idx_station_codes_station ON station_codes(station_id, code_type);

ALTER TABLE observation_run_links ADD COLUMN review_reason TEXT;
ALTER TABLE observation_run_links ADD COLUMN decision_source TEXT NOT NULL DEFAULT 'model';
ALTER TABLE observation_run_links ADD COLUMN reviewed_by TEXT;
ALTER TABLE observation_run_links ADD COLUMN reviewed_at TEXT;

CREATE TABLE IF NOT EXISTS observation_link_candidates (
  event_id TEXT NOT NULL REFERENCES events(event_id),
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  probability REAL NOT NULL,
  feature_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(event_id, run_id)
);
CREATE INDEX IF NOT EXISTS idx_observation_link_candidates_queue ON observation_link_candidates(event_id, rank);
