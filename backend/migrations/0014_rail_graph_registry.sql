CREATE TABLE IF NOT EXISTS rail_graph_versions (
  version_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_generated_at TEXT,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'importing',
  station_count INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  imported_stations INTEGER NOT NULL DEFAULT 0,
  imported_segments INTEGER NOT NULL DEFAULT 0,
  alias_conflict_count INTEGER NOT NULL DEFAULT 0,
  unmatched_station_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS station_registry (
  station_id TEXT PRIMARY KEY,
  official_name TEXT NOT NULL,
  station_type TEXT NOT NULL DEFAULT 'station',
  latitude REAL,
  longitude REAL,
  country_code TEXT NOT NULL DEFAULT 'UA',
  osm_type TEXT,
  osm_id TEXT,
  graph_node_id TEXT,
  match_method TEXT NOT NULL DEFAULT 'reviewed',
  match_confidence REAL NOT NULL DEFAULT 1,
  source_version TEXT,
  metadata_json TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_station_registry_graph_node ON station_registry(graph_node_id);
CREATE INDEX IF NOT EXISTS idx_station_registry_coordinates ON station_registry(latitude, longitude);

CREATE TABLE IF NOT EXISTS station_aliases (
  alias_key TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES station_registry(station_id),
  alias TEXT NOT NULL,
  language TEXT,
  alias_type TEXT NOT NULL DEFAULT 'name',
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  source_version TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_station_aliases_station ON station_aliases(station_id);

CREATE TABLE IF NOT EXISTS rail_segment_geometries (
  segment_id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES rail_graph_versions(version_id),
  from_station_id TEXT NOT NULL REFERENCES station_registry(station_id),
  to_station_id TEXT NOT NULL REFERENCES station_registry(station_id),
  geometry_json TEXT NOT NULL,
  distance_km REAL NOT NULL,
  railway_type TEXT NOT NULL DEFAULT 'rail',
  usage_type TEXT,
  track_count INTEGER,
  electrified TEXT,
  source_way_ids_json TEXT,
  geometry_quality REAL NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rail_segment_lookup ON rail_segment_geometries(from_station_id, to_station_id, active);
CREATE INDEX IF NOT EXISTS idx_rail_segment_version ON rail_segment_geometries(version_id, active);

CREATE TABLE IF NOT EXISTS rail_graph_import_state (
  version_id TEXT PRIMARY KEY REFERENCES rail_graph_versions(version_id),
  next_station_chunk INTEGER NOT NULL DEFAULT 0,
  next_segment_chunk INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  finished_at TEXT,
  error TEXT
);
