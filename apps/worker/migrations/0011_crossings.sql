CREATE TABLE crossings (
 id TEXT PRIMARY KEY, network_id TEXT NOT NULL REFERENCES networks(id), line_id TEXT NOT NULL REFERENCES lines(id),
 source_station_id TEXT NOT NULL REFERENCES stations(id), record TEXT NOT NULL, version INTEGER NOT NULL
);
CREATE INDEX crossings_network ON crossings(network_id);
CREATE TRIGGER crossings_version BEFORE UPDATE ON crossings WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'stale_write'); END;
CREATE TRIGGER crossing_source BEFORE INSERT ON crossings WHEN NOT EXISTS (
 SELECT 1 FROM stations WHERE id=NEW.source_station_id AND network_id=NEW.network_id AND line_id<>NEW.line_id
 AND status<>'cancelled' AND json_extract(record,'$.removalRequest') IS NULL)
BEGIN SELECT RAISE(ABORT, 'station_dependency_unavailable'); END;
CREATE TRIGGER crossing_station_removal BEFORE UPDATE ON stations
WHEN (NEW.status='cancelled' OR json_extract(NEW.record,'$.removalRequest') IS NOT NULL)
AND EXISTS (SELECT 1 FROM crossings WHERE source_station_id=NEW.id AND json_extract(record,'$.state.status')<>'complete'
AND EXISTS (SELECT 1 FROM trains WHERE line_id=crossings.line_id AND status<>'siding'))
BEGIN SELECT RAISE(ABORT,'station_dependency_unavailable'); END;
CREATE TABLE station_checkpoints (
 id TEXT PRIMARY KEY REFERENCES stations(id), network_id TEXT NOT NULL REFERENCES networks(id), record TEXT NOT NULL
);
ALTER TABLE integration_attempts ADD COLUMN purpose TEXT NOT NULL DEFAULT 'terminus';
ALTER TABLE integration_attempts ADD COLUMN target_repo_id TEXT;
ALTER TABLE integration_attempts ADD COLUMN review TEXT;
ALTER TABLE integration_attempts ADD COLUMN diff TEXT;
UPDATE integration_attempts SET target_repo_id=json_extract(input,'$.terminusRepoId');
DROP INDEX integration_active_network;
CREATE UNIQUE INDEX integration_active_target ON integration_attempts(COALESCE(target_repo_id,json_extract(input,'$.terminusRepoId'))) WHERE status IN ('cleared','prepared');

DROP TRIGGER unload_clearance_permission;
CREATE TRIGGER unload_clearance_permission BEFORE INSERT ON integration_attempts
WHEN NEW.purpose='terminus' AND EXISTS (SELECT 1 FROM train_unload_policies WHERE id=NEW.train_id
 AND json_extract(record,'$.mode')='human_approval'
 AND (json_extract(record,'$.approval.trainCommit') IS NULL OR json_extract(record,'$.approval.trainCommit')<>json_extract(NEW.input,'$.trainCommit')))
BEGIN SELECT RAISE(ABORT,'unload_permission_required'); END;
DROP TRIGGER unload_policy_closed;
CREATE TRIGGER unload_policy_closed BEFORE UPDATE ON train_unload_policies
WHEN EXISTS (SELECT 1 FROM integration_attempts WHERE train_id=NEW.id AND purpose='terminus' AND status IN ('cleared','prepared'))
 OR EXISTS (SELECT 1 FROM trains WHERE id=NEW.id AND (status IN ('unloaded','siding') OR (status='returning' AND json_extract(record,'$.state.phase')='integrating')))
BEGIN SELECT RAISE(ABORT,'unload_policy_closed'); END;
DROP TRIGGER terminus_promotion;
CREATE TRIGGER terminus_promotion BEFORE UPDATE OF terminus_commit ON networks
WHEN NEW.terminus_commit<>OLD.terminus_commit AND NOT EXISTS (
 SELECT 1 FROM integration_attempts WHERE network_id=OLD.id AND purpose='terminus' AND status='prepared'
 AND json_extract(input,'$.terminusCommit')=OLD.terminus_commit AND json_extract(candidate,'$.headCommit')=NEW.terminus_commit)
BEGIN SELECT RAISE(ABORT,'stale_write'); END;
CREATE UNIQUE INDEX cars_original ON cars(train_id,COALESCE(json_extract(record,'$.originCarId'),id));

CREATE TABLE train_siding_requests (id TEXT PRIMARY KEY REFERENCES trains(id), reason TEXT NOT NULL);
CREATE TRIGGER integration_siding BEFORE INSERT ON integration_attempts WHEN EXISTS (SELECT 1 FROM train_siding_requests WHERE id=NEW.train_id)
BEGIN SELECT RAISE(ABORT,'siding_requested'); END;

CREATE TRIGGER train_siding_gate BEFORE UPDATE ON trains
WHEN NEW.status<>'siding' AND EXISTS (SELECT 1 FROM train_siding_requests WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'stale_write'); END;
