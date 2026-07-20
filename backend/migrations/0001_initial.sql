PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  train_number TEXT NOT NULL,
  service_date TEXT NOT NULL,
  route TEXT,
  origin TEXT,
  destination TEXT,
  current_update_json TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_last_observed ON runs(last_observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_train_date ON runs(train_number, service_date);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_value_json TEXT,
  station TEXT,
  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_url TEXT,
  authority TEXT NOT NULL,
  reliability REAL NOT NULL CHECK(reliability >= 0 AND reliability <= 1),
  position_evidence TEXT NOT NULL DEFAULT 'none',
  raw_update_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_run_time ON events(run_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_observed ON events(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_station_time ON events(station, occurred_at DESC);

CREATE TABLE IF NOT EXISTS source_health (
  source_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  latency_ms INTEGER,
  records_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS segment_stats (
  from_station_id TEXT NOT NULL,
  to_station_id TEXT NOT NULL,
  train_family TEXT NOT NULL DEFAULT '*',
  sample_count INTEGER NOT NULL DEFAULT 0,
  mean_minutes REAL NOT NULL DEFAULT 0,
  variance_minutes REAL NOT NULL DEFAULT 0,
  p10_minutes REAL,
  p50_minutes REAL,
  p90_minutes REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(from_station_id, to_station_id, train_family)
);

