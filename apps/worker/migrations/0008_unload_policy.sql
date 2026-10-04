-- Dispatcher-owned final-gate permissions; Train Workflows alone write Train state.
CREATE TABLE train_unload_policies (
  id TEXT PRIMARY KEY REFERENCES trains(id),
  network_id TEXT NOT NULL REFERENCES networks(id),
  record TEXT NOT NULL,
  version INTEGER NOT NULL
);
INSERT INTO train_unload_policies (id, network_id, record, version)
  SELECT id, network_id, json_object('trainId', id, 'mode', 'auto'), 0 FROM trains;
CREATE INDEX unload_policy_network ON train_unload_policies(network_id);
CREATE TRIGGER unload_policy_version BEFORE UPDATE ON train_unload_policies
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'stale_write');
END;

-- Freeze selections before any canonical write can start, including the gap
-- between claiming clearance and the Train Workflow recording integrating.
CREATE TRIGGER unload_policy_closed BEFORE UPDATE ON train_unload_policies
WHEN EXISTS (SELECT 1 FROM integration_attempts WHERE train_id = NEW.id AND status IN ('cleared', 'prepared'))
  OR EXISTS (SELECT 1 FROM trains WHERE id = NEW.id AND (
    status IN ('unloaded', 'siding') OR
    (status = 'returning' AND json_extract(record, '$.state.phase') = 'integrating')))
BEGIN
  SELECT RAISE(ABORT, 'unload_policy_closed');
END;

CREATE TRIGGER unload_approval_baseline BEFORE UPDATE ON train_unload_policies
WHEN json_extract(NEW.record, '$.approval') IS NOT NULL AND
  json_extract(NEW.record, '$.approval') IS NOT json_extract(OLD.record, '$.approval') AND
  NOT EXISTS (SELECT 1 FROM trains WHERE id = NEW.id
    AND json_extract(record, '$.headCommit') = json_extract(NEW.record, '$.approval.trainCommit')
    AND ((status = 'returning' AND json_extract(record, '$.state.phase') = 'awaiting_clearance')
      OR (status = 'held' AND json_extract(record, '$.state.resume.status') = 'returning')))
BEGIN
  SELECT RAISE(ABORT, 'stale_write');
END;

-- Close the race between eligibility reads and a user selecting manual review.
CREATE TRIGGER unload_clearance_permission BEFORE INSERT ON integration_attempts
WHEN EXISTS (SELECT 1 FROM train_unload_policies WHERE id = NEW.train_id
  AND json_extract(record, '$.mode') = 'human_approval'
  AND (json_extract(record, '$.approval.trainCommit') IS NULL
    OR json_extract(record, '$.approval.trainCommit') <> json_extract(NEW.input, '$.trainCommit')))
BEGIN
  SELECT RAISE(ABORT, 'unload_permission_required');
END;
