CREATE TABLE IF NOT EXISTS twin_states (
  run_id TEXT PRIMARY KEY,
  train_number TEXT,
  anchor_observation_id TEXT NOT NULL,
  anchor_node_id TEXT NOT NULL,
  next_node_id TEXT,
  position_status TEXT NOT NULL,
  calculated_at TEXT NOT NULL,
  anchor_observed_at TEXT NOT NULL,
  eta_p50 TEXT,
  eta_p80_start TEXT,
  eta_p80_end TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  uncertainty_km REAL,
  method TEXT NOT NULL,
  primary_hypothesis_id TEXT,
  alternatives_count INTEGER NOT NULL DEFAULT 0,
  latitude REAL,
  longitude REAL,
  state_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_twin_states_freshness ON twin_states(position_status, calculated_at DESC);

CREATE TABLE IF NOT EXISTS twin_hypotheses (
  hypothesis_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  train_number TEXT,
  based_on_observation_id TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  probability REAL NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  eta_p50 TEXT NOT NULL,
  eta_p80_start TEXT NOT NULL,
  eta_p80_end TEXT NOT NULL,
  confidence REAL NOT NULL,
  uncertainty_km REAL,
  geometry_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  calculated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reason_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_twin_hypotheses_run ON twin_hypotheses(run_id, status, probability DESC);
CREATE INDEX IF NOT EXISTS idx_twin_hypotheses_expiry ON twin_hypotheses(status, expires_at);
