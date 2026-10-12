-- Repository overviews by commit, so browsing a commit starts a Sandbox only
-- the first time. A commit never changes, so a row never goes stale; rows
-- leave with their namespace when the network is deleted. The gzipped JSON is
-- split into chunks to stay under D1's row size limit.
CREATE TABLE repository_overviews (
  repo_id TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  chunk INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  namespace TEXT NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (repo_id, commit_id, chunk)
);
CREATE INDEX repository_overviews_namespace ON repository_overviews(namespace);
