-- When each Line was laid. The map replays Line openings and Train finishes
-- to reuse a finished Line's slot, colour and shape for the next Line.
-- Display metadata only: the Line record remains the source of truth.
ALTER TABLE lines ADD COLUMN created_at TEXT;

UPDATE lines SET created_at = COALESCE(
  (SELECT min(occurred_at) FROM events
    WHERE events.network_id = lines.network_id
      AND events.type = 'line.created'
      AND json_extract(events.payload, '$.lineId') = lines.id),
  (SELECT created_at FROM networks WHERE networks.id = lines.network_id)
);
