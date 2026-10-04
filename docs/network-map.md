# Network map UI

The React/SVG map is a projection of `NetworkSnapshot`. It reads the existing snapshot and event endpoints and submits the existing hold, release, clear-block and demo commands. It never advances a Train, starts work from an animation, or synthesizes an Engineer signal.

## Visual references

Official maps researched and visually inspected on October 3, 2026:

- [Montréal Métro](https://www.stm.info/sites/default/files/media/Stminfo/images/a-plan-metro-blanc.pdf): strong route colors, numbered route bullets, spare geographic detail, white station marks and prominent interchange rings.
- [Calgary CTrain](https://www.calgarytransit.com/content/dam/transit/rider-information/CTrain%20Map%202023.pdf): clear open station circles, easy-to-follow outer branches, disciplined diagonals, and a compact key.
- [New York City Subway](https://www.mta.info/map/5256): consistent route identifiers and thick, distinct route strokes, with clear distinction between ordinary stops and connections.
- [London Tube](https://content.tfl.gov.uk/standard-tube-map.pdf): horizontal, vertical and 45-degree geometry, consistent typography and interchange hierarchy.

The map uses this visual grammar with original geometry and no copied map assets. Unlike a city's topology, Terminus Lines do not branch or merge before Terminus. Independent approach lanes enter the central interchange; a crossing without a station marker is not a connection.

## Route shapes

Six profiles are available: direct, elbow, dogleg, staircase, sweep, and offset. The Dispatcher already assigns random UUID-based Line IDs. The renderer uses that entropy to choose a profile without replacement within each group of six Lines in snapshot order. This provides random variety while keeping geometry stable across polling and reloads; appending Lines preserves existing choices. No random draws happen during rendering, and no second copy of topology is stored in local storage.

Shape choice and coordinates belong to presentation, so no domain field, migration, or new infrastructure is needed. Route colors and numbered identifiers are shared between the diagram and directory. Extra Stations grow the canvas; zoom and scrolling provide inspection at larger network sizes.

## Interaction and state

- Select a Line, Train or Station by pointer or keyboard. The inspector shows the manifest goal, acceptance criteria, dependencies, Station order, current Train state, gate signal, reasons/issues, and accepted Cars with review and commit provenance.
- Ready Trains use their backend `at` location. Moving and approaching Trains use fixed, distinct positions on the approach to their backend target Station. These positions describe phases, not elapsed time or completion percentages.
- Held and blocked Trains remain on the map at their resume location. They use distinct labeled markers and separate summary counts. Signals come directly from `TrainView.signal`.
- Returning Trains appear on the Terminus approach. Unloaded Trains leave the track but remain inspectable in the directory/history. Sided Trains appear in a separate, selectable siding strip.
- Fit network shows the whole diagram, including on mobile. Zoom provides larger labels, with explicit scroll/swipe guidance. The mobile Line directory can be swiped independently.
- Polling failures preserve the last snapshot and display a connection warning. Initial failures retry even when no events exist. Requests are serialized; an event cursor advances only after its snapshot reload succeeds.

## Local verification

Run `npm run dev:fake` and `npm run dev:web`; never use the real execution environment for UI checks. Local browser verification covered a six-Line/18-Station network, manifest selection, keyboard selection, hold/release commands, stable geometry after reload, zoom/fit, dark mode and a 390px viewport. Browser-only response fixtures exercised blocked, held, reviewing, moving, siding and unloaded displays, plus recovery from an initial failed snapshot with an empty event stream.

Two GPT-6 Luna reviewers with high reasoning independently reviewed rendered screenshots, not source code. Their feedback led to whole-network mobile fit, explicit navigation cues, larger/staggered labels, more route variety, Train icons, a red-signal key, and separate held/blocked counts. The central radial topology remains intentional: every workstream ends at Terminus.

A real local fake-backend demo completed with both Trains `unloaded` and three accepted Cars; polling displayed the integration events and removed the Train markers. Build, workspace type checks, lint, changed-file formatting, and 146 web/pure-package tests passed. The existing Workers test suite stalled in both the default and single-worker configurations. The latter reported a pool termination timeout for `integration-operations.test.ts` and hung-runtime errors, so that suite remains unverified. No deployment or live execution was performed.
