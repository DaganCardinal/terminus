CREATE TABLE dispatch_plans (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks(id),
  status TEXT NOT NULL CHECK(status IN ('planning', 'ready', 'launching', 'starting', 'launched', 'failed')),
  record TEXT NOT NULL,
  version INTEGER NOT NULL
);
CREATE INDEX dispatch_network ON dispatch_plans(network_id);

CREATE TRIGGER dispatch_version BEFORE UPDATE ON dispatch_plans
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'stale_write');
END;

-- Close both the launch-request race and the repository-preparation race.
-- When this aborts, all Lines, Stations, Trains and events roll back too.
CREATE TRIGGER dispatch_baseline BEFORE UPDATE ON dispatch_plans
WHEN NEW.status IN ('launching', 'starting') AND NEW.status <> OLD.status
  AND json_extract(NEW.record, '$.terminusCommit') <>
    (SELECT terminus_commit FROM networks WHERE id = NEW.network_id)
BEGIN
  SELECT RAISE(ABORT, 'stale_plan');
END;
