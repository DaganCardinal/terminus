-- Dispatcher conversations: operational records of what the user and the
-- Dispatcher said. They never drive Train movement. A turn writes its
-- messages only while the conversation still names it as the active turn.
CREATE TABLE dispatcher_conversations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks(id),
  record TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  -- The HTTP request that created it, so a retried create returns it.
  request_id TEXT NOT NULL UNIQUE
);
CREATE INDEX dispatcher_conversations_network ON dispatcher_conversations(network_id, updated_at);

CREATE TABLE dispatcher_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES dispatcher_conversations(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  at TEXT NOT NULL,
  message TEXT NOT NULL,
  -- Present on user messages, so a retried send returns the original.
  request_id TEXT UNIQUE,
  UNIQUE(turn_id, position)
);
CREATE INDEX dispatcher_messages_conversation ON dispatcher_messages(conversation_id, seq);

CREATE TRIGGER dispatcher_conversations_version BEFORE UPDATE ON dispatcher_conversations
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'stale_write'); END;

CREATE TRIGGER dispatcher_conversations_deletion_insert BEFORE INSERT ON dispatcher_conversations
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER dispatcher_conversations_deletion_update BEFORE UPDATE ON dispatcher_conversations
WHEN EXISTS (SELECT 1 FROM networks WHERE id = NEW.network_id AND deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

CREATE TRIGGER dispatcher_messages_deletion_insert BEFORE INSERT ON dispatcher_messages
WHEN EXISTS (SELECT 1 FROM dispatcher_conversations c JOIN networks n ON n.id = c.network_id WHERE c.id = NEW.conversation_id AND n.deleting = 1)
BEGIN SELECT RAISE(ABORT, 'network_deleting'); END;

-- A revision starts from a copy of the revised plan's draft, which can pass
-- every check before its planner has changed anything. The flag is set when
-- the revision is created and cleared only when finalize_plan accepts it;
-- until then, no recovery path treats the saved draft as the answer.
ALTER TABLE dispatch_draft_checkpoints ADD COLUMN revising INTEGER NOT NULL DEFAULT 0;
