-- The plan a Dispatcher session is writing through its plan tools: one row for
-- the outline (part 'outline', key '') and one per Station (part 'station').
-- Each row passed its own checks when saved; the assembled proposal is still
-- validated before it becomes state. Kept after the session for diagnosis.
CREATE TABLE dispatch_drafts (
  plan_id TEXT NOT NULL REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  part TEXT NOT NULL CHECK (part IN ('outline', 'station')),
  key TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, part, key)
);

CREATE TRIGGER dispatch_drafts_deletion_insert BEFORE INSERT ON dispatch_drafts
WHEN EXISTS (SELECT 1 FROM dispatch_plans p JOIN networks n ON n.id = p.network_id WHERE p.id = NEW.plan_id AND n.deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER dispatch_drafts_deletion_update BEFORE UPDATE ON dispatch_drafts
WHEN EXISTS (SELECT 1 FROM dispatch_plans p JOIN networks n ON n.id = p.network_id WHERE p.id = NEW.plan_id AND n.deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;
