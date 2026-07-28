ALTER TABLE twin_states ADD COLUMN operational_state TEXT NOT NULL DEFAULT 'unresolved';
ALTER TABLE twin_states ADD COLUMN state_since TEXT;
ALTER TABLE twin_states ADD COLUMN previous_node_id TEXT;
ALTER TABLE twin_states ADD COLUMN dwell_minutes REAL;
ALTER TABLE twin_states ADD COLUMN state_confidence REAL NOT NULL DEFAULT 0;
ALTER TABLE twin_states ADD COLUMN transition_reason_json TEXT;

CREATE TABLE IF NOT EXISTS twin_state_transitions (
  transition_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  train_number TEXT,
  from_state TEXT,
  to_state TEXT NOT NULL,
  anchor_node_id TEXT,
  next_node_id TEXT,
  evidence_observation_id TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  calculated_at TEXT NOT NULL,
  reason_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_twin_state_transitions_run ON twin_state_transitions(run_id, calculated_at DESC);
CREATE INDEX IF NOT EXISTS idx_twin_state_transitions_state ON twin_state_transitions(to_state, calculated_at DESC);

ALTER TABLE model_evaluations ADD COLUMN source_id TEXT;
ALTER TABLE model_evaluations ADD COLUMN evaluation_kind TEXT NOT NULL DEFAULT 'replay';
ALTER TABLE model_evaluations ADD COLUMN model_version TEXT NOT NULL DEFAULT 'rail-intelligence-v2';
ALTER TABLE model_evaluations ADD COLUMN horizon_minutes REAL;
ALTER TABLE model_evaluations ADD COLUMN p80_width_minutes REAL;

UPDATE model_evaluations
SET evaluation_kind = CASE WHEN evaluation_id LIKE 'replay:%' THEN 'replay' ELSE 'prospective' END,
    model_version = 'rail-intelligence-v2';

CREATE TABLE IF NOT EXISTS model_calibration_profiles_v3 (
  profile_id TEXT PRIMARY KEY,
  dimension_type TEXT NOT NULL,
  dimension_key TEXT NOT NULL,
  train_family TEXT,
  source_id TEXT,
  from_station_id TEXT,
  to_station_id TEXT,
  evaluation_count INTEGER NOT NULL DEFAULT 0,
  prospective_count INTEGER NOT NULL DEFAULT 0,
  mae_minutes REAL,
  p80_coverage REAL,
  residual_p10_minutes REAL,
  residual_p50_minutes REAL,
  residual_p90_minutes REAL,
  bias_minutes REAL,
  uncertainty_multiplier REAL NOT NULL DEFAULT 1,
  readiness TEXT NOT NULL DEFAULT 'insufficient-evidence',
  window_started_at TEXT,
  window_ended_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_v3_dimension ON model_calibration_profiles_v3(dimension_type, dimension_key);
CREATE INDEX IF NOT EXISTS idx_calibration_v3_readiness ON model_calibration_profiles_v3(readiness, prospective_count DESC, evaluation_count DESC);

ALTER TABLE intelligence_cycles ADD COLUMN state_transitions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE intelligence_cycles ADD COLUMN prospective_evaluations INTEGER NOT NULL DEFAULT 0;
