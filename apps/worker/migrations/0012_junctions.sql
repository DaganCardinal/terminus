CREATE TABLE junctions (
 id TEXT PRIMARY KEY, network_id TEXT NOT NULL REFERENCES networks(id), record TEXT NOT NULL, version INTEGER NOT NULL
);
CREATE INDEX junctions_network ON junctions(network_id);
CREATE TRIGGER junction_version BEFORE UPDATE ON junctions WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT,'stale_write'); END;
CREATE TRIGGER junction_head BEFORE UPDATE ON junctions
WHEN json_extract(NEW.record,'$.headCommit') <> json_extract(OLD.record,'$.headCommit') AND NOT EXISTS (
 SELECT 1 FROM integration_attempts WHERE purpose='junction' AND status='prepared'
 AND json_extract(input,'$.junctionId')=OLD.id
 AND json_extract(input,'$.terminusCommit')=json_extract(OLD.record,'$.headCommit')
 AND json_extract(candidate,'$.headCommit')=json_extract(NEW.record,'$.headCommit')
 AND json_extract(result,'$.ok')=1 AND json_extract(review,'$.verdict')='accept'
)
BEGIN SELECT RAISE(ABORT,'stale_write'); END;
CREATE TABLE junction_entries (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, junction_id TEXT NOT NULL REFERENCES junctions(id), train_id TEXT NOT NULL REFERENCES trains(id),
 source_commit TEXT NOT NULL, UNIQUE(junction_id,train_id)
);
CREATE TABLE junction_commands (
 id TEXT PRIMARY KEY REFERENCES junctions(id), release_commit TEXT, retry INTEGER NOT NULL DEFAULT 0, abandon_reason TEXT
);
CREATE TRIGGER junction_release_permission BEFORE INSERT ON junction_commands
WHEN NEW.release_commit IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM junctions WHERE id=NEW.id AND json_extract(record,'$.state.status')='ready'
 AND json_extract(record,'$.headCommit')=NEW.release_commit AND json_extract(record,'$.acceptance.commit')=NEW.release_commit
)
BEGIN SELECT RAISE(ABORT,'junction_release_stale'); END;
CREATE TABLE junction_repairs (
 id TEXT PRIMARY KEY, network_id TEXT NOT NULL REFERENCES networks(id), record TEXT NOT NULL, version INTEGER NOT NULL
);
CREATE INDEX junction_repairs_network ON junction_repairs(network_id);
CREATE TRIGGER junction_repair_version BEFORE UPDATE ON junction_repairs WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT,'stale_write'); END;
CREATE UNIQUE INDEX junction_repair_active ON junction_repairs(json_extract(record,'$.source.junctionId'))
WHERE json_extract(record,'$.state.status') IN ('requested','running','reviewing','ready','approved');

CREATE TRIGGER junction_baseline BEFORE INSERT ON junctions WHEN NOT EXISTS (
 SELECT 1 FROM networks WHERE id=NEW.network_id AND terminus_commit=json_extract(NEW.record,'$.terminusBaseline')
) BEGIN SELECT RAISE(ABORT,'stale_plan'); END;
CREATE TRIGGER junction_membership BEFORE UPDATE ON junctions WHEN
 json_extract(NEW.record,'$.repoId') <> json_extract(OLD.record,'$.repoId') OR
 json_extract(NEW.record,'$.outgoingTrainId') <> json_extract(OLD.record,'$.outgoingTrainId') OR
 json_extract(NEW.record,'$.incomingLineIds') <> json_extract(OLD.record,'$.incomingLineIds') OR
 json_extract(NEW.record,'$.incomingTrainIds') <> json_extract(OLD.record,'$.incomingTrainIds') OR
 json_extract(NEW.record,'$.outgoingLineId') <> json_extract(OLD.record,'$.outgoingLineId') OR
 json_extract(NEW.record,'$.brief') <> json_extract(OLD.record,'$.brief') OR
 json_extract(NEW.record,'$.terminusBaseline') <> json_extract(OLD.record,'$.terminusBaseline')
BEGIN SELECT RAISE(ABORT,'junction_membership_frozen'); END;
CREATE TRIGGER crossing_feature_boundary BEFORE INSERT ON crossings WHEN
 COALESCE((SELECT json_extract(record,'$.destination.junctionId') FROM lines WHERE id=NEW.line_id),'terminus') <>
 COALESCE((SELECT json_extract(lines.record,'$.destination.junctionId') FROM lines JOIN stations ON lines.id=stations.line_id WHERE stations.id=NEW.source_station_id),'terminus')
BEGIN SELECT RAISE(ABORT,'crossing_feature_boundary'); END;
CREATE TRIGGER junction_entry_member BEFORE INSERT ON junction_entries WHEN NOT EXISTS (
 SELECT 1 FROM junctions, json_each(junctions.record,'$.incomingTrainIds') WHERE junctions.id=NEW.junction_id AND json_each.value=NEW.train_id
) BEGIN SELECT RAISE(ABORT,'junction_member_required'); END;
CREATE TRIGGER junction_release_permission_update BEFORE UPDATE OF release_commit ON junction_commands
WHEN NEW.release_commit IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM junctions WHERE id=NEW.id AND json_extract(record,'$.state.status')='ready'
 AND json_extract(record,'$.headCommit')=NEW.release_commit AND json_extract(record,'$.acceptance.commit')=NEW.release_commit
) BEGIN SELECT RAISE(ABORT,'junction_release_stale'); END;

CREATE TRIGGER junction_release_gates BEFORE UPDATE ON junctions
WHEN json_extract(NEW.record,'$.state.status')='released' AND json_extract(OLD.record,'$.state.status')<>'released' AND (
 json_extract(OLD.record,'$.state.status')<>'ready' OR
 NOT EXISTS (SELECT 1 FROM junction_commands WHERE id=NEW.id AND release_commit=json_extract(OLD.record,'$.headCommit')) OR
 EXISTS (SELECT 1 FROM integration_attempts WHERE target_repo_id=json_extract(OLD.record,'$.repoId') AND status IN ('cleared','prepared')) OR
 EXISTS (SELECT 1 FROM holds WHERE network_id=NEW.network_id AND (
 json_extract(record,'$.scope.kind')='network' OR
 json_extract(record,'$.scope.lineId')=json_extract(OLD.record,'$.outgoingLineId') OR
 json_extract(record,'$.scope.trainId')=json_extract(OLD.record,'$.outgoingTrainId'))) OR
 EXISTS (SELECT 1 FROM conflicts, json_each(conflicts.record,'$.trainIds') WHERE conflicts.network_id=NEW.network_id AND conflicts.status='open' AND json_each.value=json_extract(OLD.record,'$.outgoingTrainId'))
) BEGIN SELECT RAISE(ABORT,'junction_release_stale'); END;
CREATE TRIGGER junction_route_frozen BEFORE UPDATE ON lines WHEN
 (json_extract(OLD.record,'$.destination.kind')='junction' OR json_extract(OLD.record,'$.origin.kind')='junction') AND
 (json_extract(NEW.record,'$.stationIds') IS NOT json_extract(OLD.record,'$.stationIds') OR
 json_extract(NEW.record,'$.stops') IS NOT json_extract(OLD.record,'$.stops') OR
 json_extract(NEW.record,'$.origin') IS NOT json_extract(OLD.record,'$.origin') OR
 json_extract(NEW.record,'$.destination') IS NOT json_extract(OLD.record,'$.destination'))
BEGIN SELECT RAISE(ABORT,'junction_membership_frozen'); END;
CREATE TRIGGER junction_entry_snapshot BEFORE INSERT ON junction_entries WHEN NOT EXISTS (
 SELECT 1 FROM trains WHERE id=NEW.train_id AND status='returning' AND json_extract(record,'$.headCommit')=NEW.source_commit AND json_extract(record,'$.destination.junctionId')=NEW.junction_id
) BEGIN SELECT RAISE(ABORT,'stale_write'); END;
CREATE TRIGGER junction_clearance_sources BEFORE INSERT ON integration_attempts WHEN NEW.purpose='junction' AND NOT EXISTS (
 SELECT 1 FROM junctions j WHERE j.id=json_extract(NEW.input,'$.junctionId') AND j.network_id=NEW.network_id
 AND json_extract(j.record,'$.repoId')=NEW.target_repo_id AND json_extract(j.record,'$.headCommit')=json_extract(NEW.input,'$.terminusCommit')
 AND json_extract(j.record,'$.state.status') IN ('collecting','blocked') AND (
   (json_extract(NEW.input,'$.repairId') IS NOT NULL AND EXISTS (
     SELECT 1 FROM junction_repairs r WHERE r.id=json_extract(NEW.input,'$.repairId')
     AND json_extract(r.record,'$.source.junctionId')=j.id AND json_extract(r.record,'$.state.status')='approved'
     AND json_extract(r.record,'$.source.trainCommit')=json_extract(NEW.input,'$.trainCommit')
     AND json_extract(r.record,'$.source.terminusCommit')=json_extract(NEW.input,'$.terminusCommit'))) OR
   (json_extract(NEW.input,'$.repairId') IS NULL AND json_extract(j.record,'$.state.status')='collecting' AND EXISTS (
     SELECT 1 FROM trains t, json_each(j.record,'$.incomingTrainIds') member WHERE t.id=NEW.train_id AND member.value=t.id AND t.network_id=NEW.network_id AND t.status='returning'
     AND json_extract(t.record,'$.repoId')=json_extract(NEW.input,'$.trainRepoId') AND json_extract(t.record,'$.headCommit')=json_extract(NEW.input,'$.trainCommit')
     AND json_extract(t.record,'$.destination.junctionId')=j.id AND NOT EXISTS (SELECT 1 FROM json_each(j.record,'$.inputs') accepted WHERE json_extract(accepted.value,'$.trainId')=t.id)))
 )
) BEGIN SELECT RAISE(ABORT,'stale_write'); END;
