-- Clearance is a durable reservation, not a lease: a slow or restarted
-- Workflow cannot lose its place to a second writer during a Git push.
CREATE TABLE integration_attempts (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks(id),
  train_id TEXT NOT NULL REFERENCES trains(id),
  status TEXT NOT NULL CHECK(status IN ('cleared', 'prepared', 'completed', 'failed')),
  input TEXT NOT NULL,
  candidate TEXT,
  evidence TEXT,
  result TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX integration_active_network ON integration_attempts(network_id)
  WHERE status IN ('cleared', 'prepared');
CREATE INDEX integration_train ON integration_attempts(train_id, created_at);

-- Compare-and-swap for the recorded canonical head, in the same batch as
-- the completed attempt. A stale update aborts the whole transaction.
CREATE TRIGGER terminus_promotion BEFORE UPDATE OF terminus_commit ON networks
WHEN NEW.terminus_commit <> OLD.terminus_commit AND NOT EXISTS (
  SELECT 1 FROM integration_attempts
  WHERE network_id = OLD.id AND status = 'prepared'
    AND json_extract(input, '$.terminusCommit') = OLD.terminus_commit
    AND json_extract(candidate, '$.headCommit') = NEW.terminus_commit
)
BEGIN
  SELECT RAISE(ABORT, 'stale_write');
END;
