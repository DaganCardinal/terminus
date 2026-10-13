-- The network's publish repository: the Terminus commit a deployment
-- (Workers Builds) serves. Created on the first publish and only ever
-- fast-forwarded to a canonical commit. The live site URL is optional
-- information the user enters after connecting Workers Builds.
ALTER TABLE networks ADD COLUMN publish_repo_id TEXT;
ALTER TABLE networks ADD COLUMN published_commit TEXT;
ALTER TABLE networks ADD COLUMN published_at TEXT;
ALTER TABLE networks ADD COLUMN site_url TEXT;
