CREATE TABLE technician_repairs (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks(id),
  train_id TEXT NOT NULL REFERENCES trains(id),
  conflict_id TEXT NOT NULL REFERENCES conflicts(id),
  status TEXT NOT NULL CHECK(status IN ('requested', 'running', 'reviewing', 'ready', 'rejected', 'approved', 'integrated', 'failed', 'stale')),
  record TEXT NOT NULL,
  version INTEGER NOT NULL
);
CREATE INDEX technician_network ON technician_repairs(network_id);
CREATE UNIQUE INDEX technician_active_conflict ON technician_repairs(conflict_id)
  WHERE status IN ('requested', 'running', 'reviewing', 'ready', 'approved');
CREATE TRIGGER technician_version BEFORE UPDATE ON technician_repairs
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'stale_write');
END;
-- Approval compares both D1 snapshots in the same transaction as its event.
CREATE TRIGGER technician_baseline BEFORE UPDATE ON technician_repairs
WHEN NEW.status = 'approved' AND OLD.status <> 'approved' AND (
  json_extract(NEW.record, '$.source.terminusCommit') <> (SELECT terminus_commit FROM networks WHERE id = NEW.network_id)
  OR json_extract(NEW.record, '$.source.trainCommit') <> (SELECT json_extract(record, '$.headCommit') FROM trains WHERE id = NEW.train_id)
)
BEGIN
  SELECT RAISE(ABORT, 'stale_write');
END;
