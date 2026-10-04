-- Protect the domain's dependency checks against concurrent topology commands.
-- A raced cancellation retries against the new topology, then records refusal.
CREATE TRIGGER stations_cancel_dependencies BEFORE UPDATE ON stations
WHEN NEW.status = 'cancelled' AND OLD.status <> 'cancelled'
  AND EXISTS (
    SELECT 1 FROM stations AS dependent, json_each(dependent.record, '$.manifest.dependencies') AS dependency
    WHERE dependent.network_id = OLD.network_id
      AND dependent.status NOT IN ('complete', 'cancelled')
      AND dependency.value = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'stale_write');
END;

-- No new Station may depend on work already being removed or cancelled.
CREATE TRIGGER stations_insert_dependencies BEFORE INSERT ON stations
WHEN NEW.status NOT IN ('complete', 'cancelled') AND EXISTS (
  SELECT 1 FROM json_each(NEW.record, '$.manifest.dependencies') AS dependency
  JOIN stations AS prerequisite ON prerequisite.id = dependency.value
  WHERE prerequisite.status = 'cancelled'
    OR json_extract(prerequisite.record, '$.removalRequest') IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'station_dependency_unavailable');
END;

CREATE TRIGGER stations_update_dependencies BEFORE UPDATE ON stations
WHEN NEW.status NOT IN ('complete', 'cancelled')
  AND json_extract(NEW.record, '$.manifest.dependencies') <> json_extract(OLD.record, '$.manifest.dependencies')
  AND EXISTS (
    SELECT 1 FROM json_each(NEW.record, '$.manifest.dependencies') AS dependency
    JOIN stations AS prerequisite ON prerequisite.id = dependency.value
    WHERE prerequisite.status = 'cancelled'
      OR json_extract(prerequisite.record, '$.removalRequest') IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'station_dependency_unavailable');
END;
