CREATE TABLE engineer_assessments (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks(id),
  train_id TEXT NOT NULL REFERENCES trains(id),
  record TEXT NOT NULL
);
CREATE INDEX engineer_assessments_train ON engineer_assessments(network_id, train_id);
CREATE TABLE engineer_notices (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks(id),
  train_id TEXT NOT NULL REFERENCES trains(id),
  record TEXT NOT NULL,
  version INTEGER NOT NULL
);
CREATE INDEX engineer_notices_network ON engineer_notices(network_id, train_id);
CREATE INDEX events_network_type_seq ON events(network_id, type, seq);
CREATE INDEX events_train_type_seq ON events(network_id, train_id, type, seq);
CREATE INDEX events_station_seq ON events(network_id, station_id, seq);
CREATE TRIGGER engineer_notices_version BEFORE UPDATE ON engineer_notices
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'stale_write'); END;
CREATE TRIGGER engineer_assessments_deletion_insert BEFORE INSERT ON engineer_assessments
WHEN EXISTS (SELECT 1 FROM networks WHERE id=NEW.network_id AND deleting=1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;
CREATE TRIGGER engineer_notices_deletion_insert BEFORE INSERT ON engineer_notices
WHEN EXISTS (SELECT 1 FROM networks WHERE id=NEW.network_id AND deleting=1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;
CREATE TRIGGER engineer_notices_deletion_update BEFORE UPDATE ON engineer_notices
WHEN EXISTS (SELECT 1 FROM networks WHERE id=NEW.network_id AND deleting=1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER engineer_assessments_immutable BEFORE UPDATE ON engineer_assessments
BEGIN SELECT RAISE(ABORT, 'immutable_assessment'); END;
