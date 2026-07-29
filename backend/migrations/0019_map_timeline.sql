-- Cover time-slice reconstruction without changing the immutable snapshot model.
CREATE INDEX IF NOT EXISTS idx_run_snapshots_capture_run
  ON run_snapshots(captured_at DESC, run_id);