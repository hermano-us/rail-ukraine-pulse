ALTER TABLE rail_route_cache ADD COLUMN context_hash TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE rail_route_cache ADD COLUMN routing_method TEXT NOT NULL DEFAULT 'shortest-physical-path';
ALTER TABLE rail_route_cache ADD COLUMN route_score REAL;
ALTER TABLE rail_route_cache ADD COLUMN route_confidence REAL;
ALTER TABLE rail_route_cache ADD COLUMN explanation_json TEXT;
ALTER TABLE rail_route_cache ADD COLUMN alternatives_json TEXT;

DROP INDEX IF EXISTS idx_rail_route_cache_pair;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rail_route_cache_context
  ON rail_route_cache(version_id,from_station_id,to_station_id,context_hash);
CREATE INDEX IF NOT EXISTS idx_rail_route_cache_method
  ON rail_route_cache(version_id,routing_method,route_confidence,last_used_at DESC);
