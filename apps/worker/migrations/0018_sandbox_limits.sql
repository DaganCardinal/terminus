-- How many Sandboxes of each kind a network may run at once. Like
-- model_settings: one General row every network follows, plus an optional
-- override per network. A missing General row means the defaults.
CREATE TABLE sandbox_limits (
  scope TEXT PRIMARY KEY,
  network_id TEXT REFERENCES networks(id),
  limits TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'general' AND network_id IS NULL) OR scope = 'network:' || network_id)
);

-- One row per running Sandbox container, counted against its network's limit.
-- A lease is taken atomically before a container starts and released when it
-- stops; one whose Sandbox vanished expires when its container would have
-- idled out.
CREATE TABLE sandbox_leases (
  object_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  binding TEXT NOT NULL CHECK(binding IN ('SANDBOX', 'WORKSPACE_SANDBOX')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX sandbox_leases_capacity ON sandbox_leases(namespace, binding, expires_at);
