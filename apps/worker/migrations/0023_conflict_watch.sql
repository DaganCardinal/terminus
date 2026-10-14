CREATE TABLE conflict_watches (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks(id),
  train_id TEXT NOT NULL REFERENCES trains(id),
  car_id TEXT NOT NULL UNIQUE REFERENCES cars(id),
  record TEXT NOT NULL,
  version INTEGER NOT NULL
);
CREATE INDEX conflict_watches_network ON conflict_watches(network_id, train_id);
CREATE TRIGGER conflict_watches_version BEFORE UPDATE ON conflict_watches
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'stale_write'); END;
CREATE TRIGGER conflict_watches_deletion_insert BEFORE INSERT ON conflict_watches
WHEN EXISTS (SELECT 1 FROM networks WHERE id=NEW.network_id AND deleting=1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;
CREATE TRIGGER conflict_watches_deletion_update BEFORE UPDATE ON conflict_watches
WHEN EXISTS (SELECT 1 FROM networks WHERE id=NEW.network_id AND deleting=1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

-- Cars accepted before the Dispatcher watched for conflicts are recorded as
-- seen, so deploying this does not start investigations for old work.
INSERT INTO conflict_watches (id, network_id, train_id, car_id, record, version)
SELECT
  'watch-' || c.id,
  c.network_id,
  c.train_id,
  c.id,
  json_object(
    'id', 'watch-' || c.id,
    'trainId', c.train_id,
    'lineId', json_extract(t.record, '$.lineId'),
    'carId', c.id,
    'stationId', json_extract(c.record, '$.stationId'),
    'createdAt', json_extract(c.record, '$.acceptedAt'),
    'baseline', json('true'),
    'pairs', json('[]')
  ),
  0
FROM cars c JOIN trains t ON t.id = c.train_id;
