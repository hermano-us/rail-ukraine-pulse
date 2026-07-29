CREATE TABLE IF NOT EXISTS ops_prediction_changes (
  change_id TEXT PRIMARY KEY,
  movement_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  change_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  previous_json TEXT,
  current_json TEXT,
  detected_at TEXT NOT NULL,
  source_cycle_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_ops_prediction_changes_movement ON ops_prediction_changes(movement_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_prediction_changes_recent ON ops_prediction_changes(detected_at DESC, severity);
