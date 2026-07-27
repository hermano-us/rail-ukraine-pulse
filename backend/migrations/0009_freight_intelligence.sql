CREATE TABLE IF NOT EXISTS freight_observations (
  observation_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  corridor_code TEXT NOT NULL DEFAULT 'unresolved',
  freight_type TEXT NOT NULL CHECK(freight_type IN ('tank_cars','containers','grain','bulk','general_freight','unclassified_rail')),
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  content_fingerprint TEXT NOT NULL,
  evidence_excerpt TEXT NOT NULL,
  moderation_status TEXT NOT NULL DEFAULT 'pending' CHECK(moderation_status IN ('pending','corroborated','rejected','expired')),
  public_eligible INTEGER NOT NULL DEFAULT 0 CHECK(public_eligible = 0)
);
CREATE INDEX IF NOT EXISTS idx_freight_observation_time ON freight_observations(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_freight_observation_queue ON freight_observations(moderation_status,received_at DESC);
CREATE INDEX IF NOT EXISTS idx_freight_observation_fingerprint ON freight_observations(content_fingerprint,occurred_at DESC);

CREATE TABLE IF NOT EXISTS freight_source_health (
  source_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  preview_messages INTEGER NOT NULL DEFAULT 0,
  accepted_observations INTEGER NOT NULL DEFAULT 0,
  restricted_dropped INTEGER NOT NULL DEFAULT 0,
  rejected_noise INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
