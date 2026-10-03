-- Domain entities are stored whole as JSON in `record`. Columns beside it
-- exist only for querying and for optimistic locking.

CREATE TABLE networks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  terminus_repo_id TEXT NOT NULL,
  terminus_commit TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE lines (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id),
  record TEXT NOT NULL
);

CREATE INDEX lines_network ON lines (network_id);

CREATE TABLE stations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id),
  line_id TEXT NOT NULL REFERENCES lines (id),
  status TEXT NOT NULL,
  record TEXT NOT NULL,
  version INTEGER NOT NULL
);

CREATE INDEX stations_network ON stations (network_id);

CREATE INDEX stations_line ON stations (line_id);

CREATE TABLE trains (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id),
  line_id TEXT NOT NULL REFERENCES lines (id),
  status TEXT NOT NULL,
  record TEXT NOT NULL,
  version INTEGER NOT NULL
);

CREATE INDEX trains_network ON trains (network_id);

CREATE TABLE cars (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id),
  train_id TEXT NOT NULL REFERENCES trains (id),
  record TEXT NOT NULL
);

CREATE INDEX cars_network ON cars (network_id);

-- Active holds only. Released holds live on in the event log.
CREATE TABLE holds (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id),
  record TEXT NOT NULL
);

CREATE INDEX holds_network ON holds (network_id);

CREATE TABLE conflicts (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id),
  status TEXT NOT NULL,
  record TEXT NOT NULL
);

CREATE INDEX conflicts_network ON conflicts (network_id);

-- The ordered domain event log. Every state change writes its events in the
-- same batch as the change.
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  network_id TEXT NOT NULL REFERENCES networks (id),
  type TEXT NOT NULL,
  train_id TEXT,
  station_id TEXT,
  payload TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX events_network_seq ON events (network_id, seq);

CREATE INDEX events_station_type ON events (station_id, type);

-- Optimistic locking: a write must move the version forward by exactly one
-- from the version it read, or the whole batch aborts.
CREATE TRIGGER trains_version BEFORE UPDATE ON trains
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'stale_write');
END;

CREATE TRIGGER stations_version BEFORE UPDATE ON stations
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'stale_write');
END;
