-- One Network per Project. Each Network's repositories live in their own
-- Artifacts namespace, and an imported project can back only one Network.
-- `project_source` is the normalized source URL, so different spellings of
-- the same repository URL are recognized as the same project. NULL for
-- networks that start from an empty repository: each of those is its own
-- project.
ALTER TABLE networks ADD COLUMN project_source TEXT;

CREATE UNIQUE INDEX networks_project_source ON networks (project_source)
WHERE project_source IS NOT NULL;
