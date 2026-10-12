-- Bounded execution observations, separate from canonical lifecycle events.
CREATE TABLE dispatch_activity_runs (
  plan_id TEXT PRIMARY KEY REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  attempt TEXT NOT NULL
);
CREATE TABLE dispatch_activity (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  attempt TEXT NOT NULL,
  position INTEGER NOT NULL,
  at TEXT NOT NULL,
  activity TEXT NOT NULL,
  UNIQUE(plan_id, attempt, position)
);
CREATE INDEX dispatch_activity_plan ON dispatch_activity(plan_id, seq);

CREATE TRIGGER dispatch_activity_runs_deletion_insert BEFORE INSERT ON dispatch_activity_runs
WHEN EXISTS (SELECT 1 FROM dispatch_plans p JOIN networks n ON n.id = p.network_id WHERE p.id = NEW.plan_id AND n.deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER dispatch_activity_runs_deletion_update BEFORE UPDATE ON dispatch_activity_runs
WHEN EXISTS (SELECT 1 FROM dispatch_plans p JOIN networks n ON n.id = p.network_id WHERE p.id = NEW.plan_id AND n.deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER dispatch_activity_deletion_insert BEFORE INSERT ON dispatch_activity
WHEN EXISTS (SELECT 1 FROM dispatch_plans p JOIN networks n ON n.id = p.network_id WHERE p.id = NEW.plan_id AND n.deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;
