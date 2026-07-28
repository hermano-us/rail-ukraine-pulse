CREATE TABLE IF NOT EXISTS expected_train_runs (
  expected_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  service_date TEXT NOT NULL,
  train_number TEXT NOT NULL,
  origin TEXT,
  destination TEXT,
  route TEXT,
  scheduled_departure TEXT,
  scheduled_arrival TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  status_reason TEXT,
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  discovery_count INTEGER NOT NULL DEFAULT 1,
  observation_count INTEGER NOT NULL DEFAULT 0,
  last_observation_at TEXT,
  last_station TEXT,
  missing_since TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_expected_runs_date_status ON expected_train_runs(service_date, status, train_number);
CREATE INDEX IF NOT EXISTS idx_expected_runs_missing ON expected_train_runs(status, missing_since);

CREATE TABLE IF NOT EXISTS rail_coverage_gaps (
  gap_id TEXT PRIMARY KEY,
  expected_id TEXT NOT NULL REFERENCES expected_train_runs(expected_id),
  gap_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  last_checked_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coverage_gap_open ON rail_coverage_gaps(expected_id, gap_type) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_coverage_gap_queue ON rail_coverage_gaps(resolved_at, severity, opened_at);

CREATE TABLE IF NOT EXISTS observation_fusion_groups (
  fusion_id TEXT PRIMARY KEY,
  train_number TEXT NOT NULL,
  station_id TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  window_ended_at TEXT NOT NULL,
  primary_event_id TEXT NOT NULL REFERENCES events(event_id),
  member_count INTEGER NOT NULL,
  independent_sources INTEGER NOT NULL,
  effective_reliability REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'fused',
  source_ids_json TEXT NOT NULL,
  explanation_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fusion_groups_train_time ON observation_fusion_groups(train_number, window_ended_at DESC);

CREATE TABLE IF NOT EXISTS observation_fusion_members (
  fusion_id TEXT NOT NULL REFERENCES observation_fusion_groups(fusion_id),
  event_id TEXT NOT NULL REFERENCES events(event_id),
  source_id TEXT NOT NULL,
  reliability REAL NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY(fusion_id, event_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fusion_member_event ON observation_fusion_members(event_id);

CREATE TABLE IF NOT EXISTS rail_observation_submissions (
  submission_id TEXT PRIMARY KEY,
  expected_id TEXT REFERENCES expected_train_runs(expected_id),
  run_id TEXT,
  train_number TEXT NOT NULL,
  station_name TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  submission_type TEXT NOT NULL DEFAULT 'passenger',
  confidence REAL NOT NULL DEFAULT 0.4,
  note TEXT,
  moderation_status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at TEXT,
  resulting_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_rail_submissions_queue ON rail_observation_submissions(moderation_status, submitted_at DESC);

CREATE TABLE IF NOT EXISTS external_rail_sources (
  source_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country_code TEXT,
  adapter_type TEXT NOT NULL,
  access_mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requires_configuration',
  capabilities_json TEXT NOT NULL,
  required_secrets_json TEXT NOT NULL DEFAULT '[]',
  last_checked_at TEXT,
  last_success_at TEXT,
  records_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO external_rail_sources(source_id,name,country_code,adapter_type,access_mode,capabilities_json,required_secrets_json,updated_at) VALUES
  ('pkp-plk-realtime','PKP PLK Open Rail Data','PL','pkp-plk','api-key','["passenger","cross-border","realtime-operations"]','["PKP_PLK_API_URL","PKP_PLK_API_KEY"]',datetime('now')),
  ('zsr-realtime','ŽSR Train Movement','SK','generic-json','permission-required','["passenger","cross-border","station-events"]','["ZSR_RAIL_API_URL"]',datetime('now')),
  ('mav-emma','MÁV EMMA','HU','generic-json','permission-required','["passenger","cross-border","station-events"]','["MAV_RAIL_API_URL"]',datetime('now')),
  ('rne-tis','RailNetEurope TIS','EU','rne-tis','contract','["passenger","freight","cross-border","realtime-operations"]','["RNE_TIS_API_URL","RNE_TIS_TOKEN"]',datetime('now')),
  ('contract-rail-feed','Contractual rail logistics feed',NULL,'contract-json','contract','["freight","wagon-events","terminal-events"]','["CONTRACT_RAIL_API_URL","CONTRACT_RAIL_API_TOKEN"]',datetime('now'));

ALTER TABLE intelligence_cycles ADD COLUMN expected_runs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE intelligence_cycles ADD COLUMN silent_runs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE intelligence_cycles ADD COLUMN fused_observations INTEGER NOT NULL DEFAULT 0;
