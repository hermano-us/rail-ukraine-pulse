-- Public freight projection reads only delayed rail-freight evidence.
-- Keep the append-only evidence journal efficient as it grows.
CREATE INDEX IF NOT EXISTS idx_restricted_evidence_domain_occurred
  ON restricted_evidence(domain, occurred_at DESC);
