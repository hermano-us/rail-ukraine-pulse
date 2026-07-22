CREATE TABLE IF NOT EXISTS model_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  train_number TEXT NOT NULL,
  from_station_id TEXT NOT NULL,
  to_station_id TEXT NOT NULL,
  predicted_minutes REAL NOT NULL,
  actual_minutes REAL NOT NULL,
  absolute_error_minutes REAL NOT NULL,
  within_p80 INTEGER NOT NULL,
  baseline_samples INTEGER NOT NULL,
  evaluated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_evaluations_time
  ON model_evaluations(evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_model_evaluations_segment
  ON model_evaluations(from_station_id, to_station_id, train_number, evaluated_at DESC);

CREATE TABLE IF NOT EXISTS source_health_checks (
  check_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  records_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_health_checks_source_time
  ON source_health_checks(source_id, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_source_health_checks_time
  ON source_health_checks(checked_at DESC);
