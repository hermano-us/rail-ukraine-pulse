CREATE TABLE IF NOT EXISTS station_coverage_priorities (
  station_id TEXT PRIMARY KEY,
  station_name TEXT NOT NULL,
  priority_score REAL NOT NULL,
  expected_runs INTEGER NOT NULL DEFAULT 0,
  silent_runs INTEGER NOT NULL DEFAULT 0,
  ambiguous_twins INTEGER NOT NULL DEFAULT 0,
  overdue_twins INTEGER NOT NULL DEFAULT 0,
  minutes_since_fact REAL,
  reason_json TEXT NOT NULL DEFAULT '[]',
  calculated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_station_coverage_priority
  ON station_coverage_priorities(priority_score DESC, calculated_at DESC);

CREATE TABLE IF NOT EXISTS twin_recalculation_queue (
  run_id TEXT PRIMARY KEY,
  trigger_event_id TEXT,
  trigger_fusion_id TEXT,
  reason TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  queued_at TEXT NOT NULL,
  processed_at TEXT,
  result TEXT
);
CREATE INDEX IF NOT EXISTS idx_twin_recalculation_pending
  ON twin_recalculation_queue(processed_at, priority DESC, queued_at);

ALTER TABLE intelligence_cycles ADD COLUMN fusion_ambiguous INTEGER NOT NULL DEFAULT 0;
ALTER TABLE intelligence_cycles ADD COLUMN board_priorities INTEGER NOT NULL DEFAULT 0;
ALTER TABLE intelligence_cycles ADD COLUMN twins_recalculated INTEGER NOT NULL DEFAULT 0;
