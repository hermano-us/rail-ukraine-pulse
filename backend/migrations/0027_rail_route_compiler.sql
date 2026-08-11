CREATE TABLE IF NOT EXISTS run_itineraries (
  itinerary_id TEXT PRIMARY KEY,
  expected_id TEXT NOT NULL REFERENCES expected_train_runs(expected_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  service_date TEXT NOT NULL,
  train_number TEXT NOT NULL,
  origin TEXT,
  destination TEXT,
  direction_id TEXT NOT NULL,
  itinerary_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'probabilistic',
  confidence REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  stop_count INTEGER NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_itineraries_run ON run_itineraries(run_id);
CREATE INDEX IF NOT EXISTS idx_run_itineraries_lookup ON run_itineraries(service_date,train_number,direction_id,status);
CREATE INDEX IF NOT EXISTS idx_run_itineraries_hash ON run_itineraries(itinerary_hash,updated_at DESC);

CREATE TABLE IF NOT EXISTS run_itinerary_stops (
  itinerary_id TEXT NOT NULL REFERENCES run_itineraries(itinerary_id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  station_id TEXT REFERENCES station_registry(station_id),
  station_name TEXT NOT NULL,
  call_type TEXT NOT NULL DEFAULT 'scheduled',
  mandatory INTEGER NOT NULL DEFAULT 1,
  scheduled_arrival TEXT,
  scheduled_departure TEXT,
  observed_at TEXT,
  source_id TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(itinerary_id,sequence_no)
);
CREATE INDEX IF NOT EXISTS idx_run_itinerary_stops_station ON run_itinerary_stops(station_id,itinerary_id,sequence_no);
CREATE INDEX IF NOT EXISTS idx_run_itinerary_stops_name ON run_itinerary_stops(station_name,itinerary_id,sequence_no);
