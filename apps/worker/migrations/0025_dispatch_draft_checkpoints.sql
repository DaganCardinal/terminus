-- Trusted preparation context, kept separately from model-written draft pieces.
-- Matching retries can reuse baseline checks and continue the saved draft.
CREATE TABLE dispatch_draft_checkpoints (
  plan_id TEXT PRIMARY KEY REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  context TEXT NOT NULL,
  baseline TEXT NOT NULL
);

CREATE TRIGGER dispatch_draft_checkpoints_deletion_insert BEFORE INSERT ON dispatch_draft_checkpoints
WHEN EXISTS (SELECT 1 FROM dispatch_plans p JOIN networks n ON n.id = p.network_id WHERE p.id = NEW.plan_id AND n.deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER dispatch_draft_checkpoints_deletion_update BEFORE UPDATE ON dispatch_draft_checkpoints
WHEN EXISTS (SELECT 1 FROM dispatch_plans p JOIN networks n ON n.id = p.network_id WHERE p.id = NEW.plan_id AND n.deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;
