-- Public freight projection is implemented in application code and requires no
-- schema change. The production D1 database is at its current storage limit, so
-- building an additional index here would make an otherwise safe deployment
-- fail. Keep this migration as a recorded no-op; add the optional read index
-- only after retention/archival has released database space.
SELECT 1;
