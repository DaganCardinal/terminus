ALTER TABLE networks ADD COLUMN validation TEXT NOT NULL DEFAULT '[{"name":"typecheck","command":["npm","run","typecheck"]},{"name":"test","command":["npm","test"]},{"name":"build","command":["npm","run","build"]}]';

-- Independently collected run evidence survives Sandbox loss and Workflow retries.
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id),
  network_id TEXT NOT NULL REFERENCES networks(id),
  input TEXT NOT NULL,
  result TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0, 1)),
  recorded_at TEXT NOT NULL
);
CREATE INDEX agent_runs_station ON agent_runs(station_id);

-- A validated verdict is durable before any accepted commit moves a Train.
CREATE TABLE conductor_reviews (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id),
  network_id TEXT NOT NULL REFERENCES networks(id),
  input TEXT NOT NULL,
  result TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX conductor_reviews_station ON conductor_reviews(station_id);
