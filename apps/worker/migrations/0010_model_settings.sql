-- Which models each role runs with. One General row ('general') that every
-- network follows, plus an optional override per network. A missing General
-- row means the default preset; a missing network row follows General.
CREATE TABLE model_settings (
  scope TEXT PRIMARY KEY,
  network_id TEXT REFERENCES networks(id),
  settings TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'general' AND network_id IS NULL) OR scope = 'network:' || network_id)
);
