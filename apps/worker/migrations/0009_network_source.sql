-- The public Git URL a network's Terminus repository was imported from, so
-- the UI can link back to the upstream project. NULL for networks created
-- empty, and for networks created before this was recorded.
ALTER TABLE networks ADD COLUMN source_url TEXT;
