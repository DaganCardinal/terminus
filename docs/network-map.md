# Network map UI

The React/SVG map is a projection of `NetworkSnapshot`. It reads the existing snapshot and event endpoints and submits the existing hold, release, clear-block and demo commands. It never advances a Train, starts work from an animation, or synthesizes an Engineer signal.

## Visual references

Official maps researched and visually inspected on October 3, 2026:

- [Montréal Métro](https://www.stm.info/sites/default/files/media/Stminfo/images/a-plan-metro-blanc.pdf): strong route colors, numbered route bullets, spare geographic detail, white station marks and prominent interchange rings.
- [Calgary CTrain](https://www.calgarytransit.com/content/dam/transit/rider-information/CTrain%20Map%202023.pdf): clear open station circles, easy-to-follow outer branches, disciplined diagonals, and a compact key.
- [New York City Subway](https://www.mta.info/map/5256): consistent route identifiers and thick, distinct route strokes, with clear distinction between ordinary stops and connections.
- [London Tube](https://content.tfl.gov.uk/standard-tube-map.pdf): horizontal, vertical and 45-degree geometry, consistent typography and interchange hierarchy.

The map uses this visual grammar with original geometry and no copied map assets. Unlike a city's topology, Terminus Lines do not branch or merge before Terminus. Independent approach lanes enter the central interchange; a crossing without a station marker is not a connection.

## Route geometry

Lines follow the curve discipline of the Montréal and London maps. Control points stay on horizontal, vertical and 45-degree segments, and every change of direction is drawn as a circular curve, never a hard corner (`apps/web/src/map/track.ts`). The base radius is about three and a half line widths; a curve shrinks only where neighbouring straights are too short to fit it.

- **Stations sit only on straight horizontal track**, at least a curve clearance away from any bend, with even spacing along the straight runs. Labels sit directly above their Station; the Station's status appears beneath the name only when it is not `waiting`, which keeps space below the track for Train markers.
- **Route bullets mark the depot end** of each Line, with the Line name above the bullet, as Montréal does at its termini.
- **Approach lanes form a parallel bundle.** On each side of Terminus, upper Lines curve down and lower Lines curve up into evenly spaced entry ports, on concentric curves. Rows are placed from Terminus outward so that no Line crosses another and none needs a short jog; an odd middle row runs straight in. With many Lines, Terminus becomes a capsule interchange so every port reaches it.
- **Selecting a Line dims the others** so its route reads at a glance.
- **A Train is a dot on its track**, cased like the track, with a core tinted by its status that pulses while it is working. Its status label hangs below on a short leader, in the space kept clear under Stations.

Six station-track profiles are available: direct, elbow, dogleg, staircase, sweep, and offset. The Dispatcher already assigns random UUID-based Line IDs. The renderer uses that entropy to choose a profile without replacement within each group of six Lines in snapshot order. This provides random variety while keeping geometry stable across polling and reloads; appending Lines preserves existing choices. No random draws happen during rendering, and no second copy of topology is stored in local storage.

Shape choice and coordinates belong to presentation, so no domain field, migration, or new infrastructure is needed. Route colors and numbered identifiers are shared between the diagram and directory. Extra Stations widen the canvas and extra Lines make it taller; the canvas is trimmed to what is drawn, and zoom and scrolling provide inspection at larger network sizes.
