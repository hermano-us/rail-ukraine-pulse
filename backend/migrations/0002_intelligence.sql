CREATE TABLE IF NOT EXISTS quarantine (
  quarantine_id TEXT PRIMARY KEY, observed_at TEXT NOT NULL, source_id TEXT,
  train_number TEXT, reasons_json TEXT NOT NULL, raw_update_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', resolution TEXT, resolved_at TEXT, resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_quarantine_status_time ON quarantine(status, observed_at DESC);

CREATE TABLE IF NOT EXISTS collection_cycles (
  cycle_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
  status TEXT NOT NULL, duration_ms INTEGER, new_events INTEGER DEFAULT 0,
  duplicate_events INTEGER DEFAULT 0, accepted_updates INTEGER DEFAULT 0,
  quarantined_updates INTEGER DEFAULT 0, sources_online INTEGER DEFAULT 0,
  sources_total INTEGER DEFAULT 0, error TEXT
);
CREATE INDEX IF NOT EXISTS idx_cycles_started ON collection_cycles(started_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit (
  audit_id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, actor TEXT NOT NULL,
  role TEXT NOT NULL, action TEXT NOT NULL, target TEXT, details_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON admin_audit(occurred_at DESC);

CREATE TABLE IF NOT EXISTS source_config (
  source_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 50, reliability REAL NOT NULL DEFAULT .5,
  updated_at TEXT NOT NULL, updated_by TEXT
);

CREATE TABLE IF NOT EXISTS station_schedule (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  station_id TEXT NOT NULL, station_name TEXT NOT NULL, sequence INTEGER NOT NULL,
  planned_arrival TEXT, planned_departure TEXT, actual_arrival TEXT, actual_departure TEXT,
  dwell_minutes REAL, status TEXT NOT NULL DEFAULT 'planned', updated_at TEXT NOT NULL,
  PRIMARY KEY(run_id, station_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_station_schedule_run_seq ON station_schedule(run_id, sequence);

CREATE TABLE IF NOT EXISTS segment_observations (
  observation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, train_number TEXT NOT NULL,
  train_category TEXT NOT NULL DEFAULT 'passenger', from_station_id TEXT NOT NULL,
  to_station_id TEXT NOT NULL, departed_at TEXT NOT NULL, arrived_at TEXT NOT NULL,
  travel_minutes REAL NOT NULL, weekday INTEGER NOT NULL, season TEXT NOT NULL,
  entry_delay_minutes REAL, exit_delay_minutes REAL, recovered_minutes REAL,
  dwell_minutes REAL, observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segment_observation_model ON segment_observations(train_number, weekday, season, from_station_id, to_station_id);
