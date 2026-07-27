CREATE TABLE IF NOT EXISTS rail_nodes (
  node_id TEXT PRIMARY KEY,
  station_name TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  country_code TEXT NOT NULL DEFAULT 'UA',
  node_type TEXT NOT NULL DEFAULT 'station',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_rail_nodes_activity ON rail_nodes(last_seen_at DESC, observation_count DESC);

CREATE TABLE IF NOT EXISTS rail_edges (
  edge_id TEXT PRIMARY KEY,
  from_node_id TEXT NOT NULL REFERENCES rail_nodes(node_id),
  to_node_id TEXT NOT NULL REFERENCES rail_nodes(node_id),
  train_family TEXT NOT NULL,
  geometry_json TEXT,
  distance_km REAL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  p10_minutes REAL,
  p50_minutes REAL,
  p90_minutes REAL,
  reliability REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rail_edges_from ON rail_edges(from_node_id, sample_count DESC);
CREATE INDEX IF NOT EXISTS idx_rail_edges_to ON rail_edges(to_node_id, sample_count DESC);

CREATE TABLE IF NOT EXISTS rail_observations (
  observation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  train_number TEXT,
  node_id TEXT NOT NULL,
  station_name TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  source_id TEXT NOT NULL,
  authority TEXT,
  reliability REAL NOT NULL DEFAULT 0.5,
  evidence_type TEXT NOT NULL DEFAULT 'station_report',
  latitude REAL,
  longitude REAL,
  evidence_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_rail_observations_run_time ON rail_observations(run_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_rail_observations_node_time ON rail_observations(node_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS twin_predictions (
  prediction_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  train_number TEXT,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  based_on_observation_id TEXT NOT NULL,
  predicted_at TEXT NOT NULL,
  eta_p50 TEXT NOT NULL,
  eta_p80_start TEXT NOT NULL,
  eta_p80_end TEXT NOT NULL,
  confidence REAL NOT NULL,
  method TEXT NOT NULL,
  baseline_samples INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_observation_id TEXT,
  actual_at TEXT,
  absolute_error_minutes REAL,
  within_p80 INTEGER,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_twin_predictions_pending ON twin_predictions(run_id, to_node_id, status, predicted_at DESC);
CREATE INDEX IF NOT EXISTS idx_twin_predictions_time ON twin_predictions(predicted_at DESC);

CREATE TABLE IF NOT EXISTS trajectory_points (
  trajectory_point_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  sequence INTEGER,
  occurred_at TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  confidence REAL NOT NULL,
  reconstruction_method TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trajectory_run_time ON trajectory_points(run_id, occurred_at);

CREATE TABLE IF NOT EXISTS ops_movements (
  movement_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  train_number TEXT,
  movement_type TEXT NOT NULL DEFAULT 'passenger',
  origin TEXT,
  destination TEXT,
  route TEXT,
  status TEXT NOT NULL DEFAULT 'observed',
  delay_minutes REAL,
  eta TEXT,
  last_station TEXT,
  last_observed_at TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  confidence REAL,
  position_status TEXT,
  workflow_state TEXT NOT NULL DEFAULT 'monitoring',
  assigned_to TEXT,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_ops_movements_state ON ops_movements(workflow_state, last_observed_at DESC);

CREATE TABLE IF NOT EXISTS ops_workflows (
  workflow_id TEXT PRIMARY KEY,
  movement_id TEXT,
  workflow_type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',
  title TEXT NOT NULL,
  description TEXT,
  assigned_to TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);
CREATE INDEX IF NOT EXISTS idx_ops_workflows_queue ON ops_workflows(state, priority, updated_at DESC);

CREATE TABLE IF NOT EXISTS ops_notifications (
  notification_id TEXT PRIMARY KEY,
  movement_id TEXT,
  notification_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  details_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_ops_notifications_open ON ops_notifications(acknowledged_at, occurred_at DESC);

CREATE TABLE IF NOT EXISTS node_activity_scores (
  score_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  window_ended_at TEXT NOT NULL,
  observation_count INTEGER NOT NULL,
  unique_runs INTEGER NOT NULL,
  baseline_per_hour REAL NOT NULL,
  activity_score REAL NOT NULL,
  change_ratio REAL,
  confidence REAL NOT NULL,
  calculated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_node_activity_latest ON node_activity_scores(calculated_at DESC, activity_score DESC);

CREATE TABLE IF NOT EXISTS network_anomalies (
  anomaly_id TEXT PRIMARY KEY,
  anomaly_type TEXT NOT NULL,
  node_id TEXT,
  corridor_id TEXT,
  severity TEXT NOT NULL,
  score REAL NOT NULL,
  summary TEXT NOT NULL,
  evidence_json TEXT,
  detected_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_network_anomalies_open ON network_anomalies(status, detected_at DESC);

CREATE TABLE IF NOT EXISTS international_corridors (
  corridor_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  countries_json TEXT NOT NULL,
  border_nodes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'configured',
  activity_score REAL,
  last_observed_at TEXT,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS intelligence_cycles (
  cycle_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  nodes_updated INTEGER NOT NULL DEFAULT 0,
  edges_updated INTEGER NOT NULL DEFAULT 0,
  observations_added INTEGER NOT NULL DEFAULT 0,
  predictions_created INTEGER NOT NULL DEFAULT 0,
  predictions_resolved INTEGER NOT NULL DEFAULT 0,
  anomalies_detected INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_intelligence_cycles_time ON intelligence_cycles(started_at DESC);

INSERT OR IGNORE INTO international_corridors(corridor_id, name, countries_json, border_nodes_json, status, metadata_json) VALUES
  ('ua-pl', 'Ukraine - Poland', '["UA","PL"]', '[]', 'configured', '{"direction":"west"}'),
  ('ua-sk', 'Ukraine - Slovakia', '["UA","SK"]', '[]', 'configured', '{"direction":"west"}'),
  ('ua-hu', 'Ukraine - Hungary', '["UA","HU"]', '[]', 'configured', '{"direction":"west"}'),
  ('ua-ro', 'Ukraine - Romania', '["UA","RO"]', '[]', 'configured', '{"direction":"southwest"}'),
  ('ua-md', 'Ukraine - Moldova', '["UA","MD"]', '[]', 'configured', '{"direction":"southwest"}');
