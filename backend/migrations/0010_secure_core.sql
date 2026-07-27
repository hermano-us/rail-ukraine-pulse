CREATE TABLE IF NOT EXISTS access_users (
  user_id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','senior_curator','logistics_coordinator','operator','observer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','archived')),
  access_key_salt TEXT NOT NULL,
  access_key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS access_sessions (
  session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES access_users(user_id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_access_sessions_user ON access_sessions(user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_sessions_token ON access_sessions(token_hash);

CREATE TABLE IF NOT EXISTS feature_flags (
  flag_key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  scope TEXT NOT NULL DEFAULT 'server' CHECK(scope IN ('server','restricted_ui','public_ui')),
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

INSERT OR IGNORE INTO feature_flags(flag_key,enabled,scope,updated_at,updated_by) VALUES
  ('FEATURE_INTERNAL_LOGISTICS',0,'restricted_ui',datetime('now'),'migration'),
  ('FEATURE_RESTRICTED_MAP',0,'restricted_ui',datetime('now'),'migration'),
  ('FEATURE_RESTRICTED_EVIDENCE',1,'restricted_ui',datetime('now'),'migration'),
  ('FEATURE_TELEGRAM_COLLECTOR',1,'server',datetime('now'),'migration'),
  ('FEATURE_TIKTOK_LINK_INTAKE',0,'restricted_ui',datetime('now'),'migration'),
  ('FEATURE_HISTORICAL_MODEL',1,'server',datetime('now'),'migration'),
  ('FEATURE_ANOMALY_DETECTION',0,'server',datetime('now'),'migration'),
  ('FEATURE_WEATHER_CONTEXT',0,'server',datetime('now'),'migration'),
  ('FEATURE_SATELLITE_CONTEXT',0,'restricted_ui',datetime('now'),'migration'),
  ('FEATURE_NODE_ACTIVITY_SCORE',0,'restricted_ui',datetime('now'),'migration'),
  ('FEATURE_MANUAL_CORRECTIONS',1,'restricted_ui',datetime('now'),'migration');

CREATE TABLE IF NOT EXISTS restricted_evidence (
  evidence_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_url TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  content_fingerprint TEXT,
  evidence_excerpt TEXT NOT NULL,
  classification_json TEXT NOT NULL DEFAULT '{}',
  location_json TEXT NOT NULL DEFAULT '{}',
  corridor_code TEXT,
  linked_run_id TEXT,
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  sensitivity_level TEXT NOT NULL DEFAULT 'restricted' CHECK(sensitivity_level IN ('internal','restricted','highly_restricted')),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','in_review','corroborated','rejected','needs_context','expired')),
  assigned_to TEXT REFERENCES access_users(user_id),
  reviewed_by TEXT REFERENCES access_users(user_id),
  reviewed_at TEXT,
  resolution_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_restricted_evidence_queue ON restricted_evidence(review_status, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_restricted_evidence_fingerprint ON restricted_evidence(content_fingerprint, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_restricted_evidence_run ON restricted_evidence(linked_run_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS secure_audit (
  audit_id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_secure_audit_time ON secure_audit(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_secure_audit_entity ON secure_audit(entity_type, entity_id, occurred_at DESC);

CREATE TRIGGER IF NOT EXISTS secure_audit_no_update
BEFORE UPDATE ON secure_audit BEGIN SELECT RAISE(ABORT, 'secure_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS secure_audit_no_delete
BEFORE DELETE ON secure_audit BEGIN SELECT RAISE(ABORT, 'secure_audit is append-only'); END;
