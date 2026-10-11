-- Sandboxes now live in two Durable Object namespaces, and an object id only
-- resolves in its own. Existing registrations all belong to SANDBOX.
ALTER TABLE network_sandboxes ADD COLUMN binding TEXT NOT NULL DEFAULT 'SANDBOX'
  CHECK(binding IN ('SANDBOX', 'WORKSPACE_SANDBOX'));
