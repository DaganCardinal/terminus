-- When each Train entered its current status, and the state it left to get
-- there. The map uses these to pace a moving Train and to leave a blocked
-- Train where it stopped. Display metadata only: the Train record remains the
-- source of truth for what the Train is doing.
--
-- Existing rows stay NULL until their next status change. Snapshots fall back
-- to the Train's latest event, which is when its last status change happened.
ALTER TABLE trains ADD COLUMN state_entered_at TEXT;
ALTER TABLE trains ADD COLUMN previous_state TEXT;
ALTER TABLE trains ADD COLUMN previous_entered_at TEXT;
