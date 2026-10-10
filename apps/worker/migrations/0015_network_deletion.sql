-- A temporary deletion fence. All network data, including this flag, is erased
-- only after its external resources have been removed.
ALTER TABLE networks ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0 CHECK(deleting IN (0, 1));

-- Container identities survive failed cleanup, including random review/Git sessions.
CREATE TABLE network_sandboxes (
  object_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL
);
CREATE INDEX network_sandboxes_namespace ON network_sandboxes(namespace);

-- Onboarding needs Git before the Network is persisted. This authorization is
-- removed when repository preparation ends, and is never a retained network.
CREATE TABLE repository_provisions (namespace TEXT PRIMARY KEY);

CREATE TRIGGER sandbox_deletion_fence BEFORE INSERT ON network_sandboxes
WHEN EXISTS (SELECT 1 FROM networks WHERE terminus_repo_id = NEW.namespace || '/terminus' AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;
CREATE TRIGGER network_deletion_fence BEFORE UPDATE ON networks
WHEN OLD.deleting = 1 AND NEW.deleting <> 1
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER lines_deletion_insert BEFORE INSERT ON lines
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER lines_deletion_update BEFORE UPDATE ON lines
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER stations_deletion_insert BEFORE INSERT ON stations
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER stations_deletion_update BEFORE UPDATE ON stations
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER trains_deletion_insert BEFORE INSERT ON trains
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER trains_deletion_update BEFORE UPDATE ON trains
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER cars_deletion_insert BEFORE INSERT ON cars
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER cars_deletion_update BEFORE UPDATE ON cars
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER holds_deletion_insert BEFORE INSERT ON holds
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER holds_deletion_update BEFORE UPDATE ON holds
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER conflicts_deletion_insert BEFORE INSERT ON conflicts
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER conflicts_deletion_update BEFORE UPDATE ON conflicts
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER events_deletion_insert BEFORE INSERT ON events
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER events_deletion_update BEFORE UPDATE ON events
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER agent_runs_deletion_insert BEFORE INSERT ON agent_runs
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER agent_runs_deletion_update BEFORE UPDATE ON agent_runs
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER conductor_reviews_deletion_insert BEFORE INSERT ON conductor_reviews
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER conductor_reviews_deletion_update BEFORE UPDATE ON conductor_reviews
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER integration_attempts_deletion_insert BEFORE INSERT ON integration_attempts
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER integration_attempts_deletion_update BEFORE UPDATE ON integration_attempts
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER dispatch_plans_deletion_insert BEFORE INSERT ON dispatch_plans
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER dispatch_plans_deletion_update BEFORE UPDATE ON dispatch_plans
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER technician_repairs_deletion_insert BEFORE INSERT ON technician_repairs
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER technician_repairs_deletion_update BEFORE UPDATE ON technician_repairs
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER train_unload_policies_deletion_insert BEFORE INSERT ON train_unload_policies
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER train_unload_policies_deletion_update BEFORE UPDATE ON train_unload_policies
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER model_settings_deletion_insert BEFORE INSERT ON model_settings
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER model_settings_deletion_update BEFORE UPDATE ON model_settings
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER crossings_deletion_insert BEFORE INSERT ON crossings
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER crossings_deletion_update BEFORE UPDATE ON crossings
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER station_checkpoints_deletion_insert BEFORE INSERT ON station_checkpoints
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER station_checkpoints_deletion_update BEFORE UPDATE ON station_checkpoints
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER junctions_deletion_insert BEFORE INSERT ON junctions
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER junctions_deletion_update BEFORE UPDATE ON junctions
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER junction_repairs_deletion_insert BEFORE INSERT ON junction_repairs
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER junction_repairs_deletion_update BEFORE UPDATE ON junction_repairs
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER execution_configs_deletion_insert BEFORE INSERT ON execution_configs
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER execution_configs_deletion_update BEFORE UPDATE ON execution_configs
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER train_siding_requests_deletion_insert BEFORE INSERT ON train_siding_requests
WHEN EXISTS (SELECT 1 FROM trains p JOIN networks n ON n.id=p.network_id WHERE p.id=NEW.id AND n.deleting=1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER train_siding_requests_deletion_update BEFORE UPDATE ON train_siding_requests
WHEN EXISTS (SELECT 1 FROM trains p JOIN networks n ON n.id=p.network_id WHERE p.id=NEW.id AND n.deleting=1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER junction_commands_deletion_insert BEFORE INSERT ON junction_commands
WHEN EXISTS (SELECT 1 FROM junctions p JOIN networks n ON n.id=p.network_id WHERE p.id=NEW.id AND n.deleting=1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER junction_commands_deletion_update BEFORE UPDATE ON junction_commands
WHEN EXISTS (SELECT 1 FROM junctions p JOIN networks n ON n.id=p.network_id WHERE p.id=NEW.id AND n.deleting=1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER junction_entries_deletion_insert BEFORE INSERT ON junction_entries
WHEN EXISTS (SELECT 1 FROM junctions p JOIN networks n ON n.id=p.network_id WHERE p.id=NEW.junction_id AND n.deleting=1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER junction_entries_deletion_update BEFORE UPDATE ON junction_entries
WHEN EXISTS (SELECT 1 FROM junctions p JOIN networks n ON n.id=p.network_id WHERE p.id=NEW.junction_id AND n.deleting=1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;
