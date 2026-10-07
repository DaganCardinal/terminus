-- Execution configuration is immutable metadata, never a second lifecycle writer.
CREATE TABLE execution_configs (
  kind TEXT NOT NULL CHECK (kind IN ('train', 'dispatch_plan', 'technician_repair', 'junction')),
  work_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks(id),
  config TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, work_id)
);
CREATE TRIGGER immutable_execution_configs BEFORE UPDATE ON execution_configs
BEGIN
  SELECT RAISE(ABORT, 'Execution configuration is immutable');
END;
