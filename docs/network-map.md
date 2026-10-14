# Network map UI

The React/SVG map is a projection of `NetworkSnapshot`. The browser loads a snapshot, polls domain events and reloads the snapshot when state changes. Map controls submit application commands for holds, intervention, approvals, previews and inspection. The map never advances a Train, starts work from an animation, or synthesizes an Engineer signal.

## Visual references

Visual references:

- [Montréal Métro](https://www.stm.info/sites/default/files/media/Stminfo/images/a-plan-metro-blanc.pdf): strong route colors, numbered route bullets, spare geographic detail, white station marks and prominent interchange rings.
- [Calgary CTrain](https://www.calgarytransit.com/content/dam/transit/rider-information/CTrain%20Map%202023.pdf): clear open station circles, easy-to-follow outer branches, disciplined diagonals, and a compact key.
- [New York City Subway](https://www.mta.info/map/5256): consistent route identifiers and thick, distinct route strokes, with clear distinction between ordinary stops and connections.
- [London Tube](https://content.tfl.gov.uk/standard-tube-map.pdf): horizontal, vertical and 45-degree geometry, consistent typography and interchange hierarchy.

The map uses this visual grammar with original geometry and no copied map assets. Each Line is an ordered route with one owner; it does not branch. Configured Crossings visit another Line's accepted Station checkpoint, and Junctions collect several incoming Lines before a released outgoing Line continues toward Terminus. A geometric track crossing without a Station/interchange marker is not a domain connection.

## Crossings and Junctions

Ordinary Lines approach Terminus on separate lanes. Networks with Crossings or Junctions use a graph layout: route order determines columns, and Lines retain their own rows except when visiting a source Station or approaching a convergence point.

A Crossing draws receiving lanes alongside the source Station and then returns each receiver to its own route. When route order cannot place the receiver at the source Station's column, a remote pickup marker on its own row links back to that Station. Both representations show the same configured pickup; drawing an intersection never creates one. The source Station retains one implementation owner.

Incoming Lines approach a Junction ring or capsule on separate lanes. Its coloured ring segments show accepted inputs, and its status indicates collection, review, release or a blocker. The outgoing Line starts at the Junction; its Train appears only after backend release. Incoming unloading represents feature convergence, while the outgoing Train's eventual Terminus integration changes canonical state. See [Crossings](crossings.md) and [Junctions](junctions.md).

## Route geometry

Lines follow the curve discipline of the Montréal and London maps. Control points stay on horizontal, vertical and 45-degree segments, and every change of direction is drawn as a circular curve, never a hard corner (`apps/web/src/map/track.ts`). The base radius is about three and a half line widths; a curve shrinks only where neighbouring straights are too short to fit it.

- **Stations sit only on straight horizontal track**, at least a curve clearance away from any bend, with even spacing along the straight runs. Labels sit directly above their Station; the Station's status appears beneath the name only when it is not `waiting`, which keeps space below the track for Train markers.
- **Route bullets mark the origin** of each Line, with the Line name above the bullet. Ordinary Lines start at a depot; released feature work starts at a Junction.
- **Approach lanes form a parallel bundle.** On each side of Terminus, upper Lines curve down and lower Lines curve up into evenly spaced entry ports, on concentric curves. Rows are placed from Terminus outward so that no Line crosses another and none needs a short jog; an odd middle row runs straight in. With many Lines, Terminus becomes a capsule interchange so every port reaches it.
- **Selecting a Line dims the others** so its route reads at a glance.
- **A Train is a dot on its track**, cased like the track, with a core tinted by its status that pulses while it is working. Its status label hangs below on a short leader, in the space kept clear under Stations.
- **A departure sends a signal pulse** down the track from the Train to the Station it signaled: a white head with a fading tail, the width of the line. Only departures seen while the map is open (or within the last few seconds) pulse, so reloads never replay them.
- **Destinations are approached like Stations.** A returning Train eases on from its last stop toward a point outside Terminus or its Junction destination, and runs in when the backend records unloading.
- **A cleared Train stays where its block stopped it.** In the domain, clearing sends it back to its last stop to run the Station again; the map replays the event log to keep it where it stopped, labelled *clearing block*, until that work is ready, it reaches Terminus, or it moves on to another Station.

Six station-track profiles are available: direct, elbow, dogleg, staircase, sweep, and offset. UUID-based Line IDs seed deterministic selection among the least-used profiles. With more Lines than profiles, profiles can repeat. No random draws happen during rendering, and no second copy of topology is stored in local storage.

While `in_transit`, the Train eases toward a waiting point short of its next stop. This motion is indeterminate presentation, not percentage completion. `approaching` comes from backend readiness; held and blocked Trains retain visible reasons and cannot move because a timer or animation completed.

## Live and finished Lines

The map shows **Live** Lines by default. A Line finishes when its Train unloads or is sided; Lines joined by a Crossing or Junction finish together, so the drawn topology is always whole. A Line whose Train you watched unload fades out as the Train enters Terminus. **Finished** switches the map to the finished Lines, most recent first; selecting a Line elsewhere switches to the view that draws it. The siding and review yard stay visible in both.

Each Line has an identity: a slot (its number and its side and row), a palette colour, a profile and a generation. `lineIdentities` (`packages/protocol/src/line-identity.ts`) replays Line openings (`lines.created_at`) and Train finishes, so a live Line keeps its identity, and a finished Line's slot, colour and profile can be reused. Linked Crossing/Junction Lines release their identities together. Lines named after a palette colour (Red, Blue, Green, Purple, Orange) take it while it is available. Finished Lines keep the identity they had, so two finished Lines can share a number. The replay is pure, so the map, drawers, Dispatcher plan previews and the networks list agree on every poll and reload.

Lines laid while the Network stays busy share a generation. Finished rows remain part of that generation's layout until reused, so remaining Trains do not jump or change their approach geometry when another Line unloads. Once every linked group has finished, the next Line starts a new generation. `layoutHistory` (`apps/web/src/map/layout.ts`) retains each finished Line's last active layout; Live and Finished filter the same historical coordinates around a shared Terminus anchor. The canvas grows with the largest layout rather than the total number of historical Lines.

Identities and coordinates belong to presentation. They are derived from persisted topology, creation times and terminal states, not stored as another domain model. More Stations need wider routes and more concurrent Lines need more rows; zoom and scrolling support larger networks without driving execution.
