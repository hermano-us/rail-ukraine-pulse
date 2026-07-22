CREATE TABLE IF NOT EXISTS run_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL,
  source_updated_at TEXT,
  update_json TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_snapshots_run_capture
  ON run_snapshots(run_id, captured_at);

CREATE INDEX IF NOT EXISTS idx_run_snapshots_capture
  ON run_snapshots(captured_at DESC);
