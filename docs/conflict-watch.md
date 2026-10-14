# Dispatcher conflict watch

Planning forecasts collisions between Lines from their manifests. The conflict watch refines that forecast with actual changes: every Car a Conductor accepts is checked against the other running Trains, and the Dispatcher tells the user about likely conflicts before the second Train reaches Terminus. Reports are advisory. They never hold, block or move a Train, and they are not `Conflict` records, which only real merge failures create.

## Pipeline

1. **Screen (deterministic, in the Train Workflow).** After a move that attaches a Car, the Train's `Dispatcher conflict watch` step records a watch for each new Car (`watchNewCars`). `screenCar` compares the Car with every other running Train on another Line:
   - files both Trains changed, or areas an unfinished Station on the other Line still plans to change (`expectedAreas`), go straight to investigation (`route: overlap`);
   - other Trains with Cars or planned Stations go to Clef, closest first (shared directories and contracts), at most `MAX_TRIAGE_PAIRS`;
   - Trains with an unacknowledged report with this Train are left out. A running check examines earlier snapshots, so newer Cars still get their own watches and checks against the current heads.
   Copied Cars (Crossings, Junctions) are recorded but never screened. If any pair needs a model, the step starts a Conflict Watch Workflow; the Train never waits for it. Persistence or launch failures are retried within the step; if retries run out, the Train continues and later passes retry unwatched Cars and pending watches, including while held.
2. **Triage (Dispatcher Clef).** The Conflict Watch Workflow asks the network's Clef model one yes/no question per gray-zone pair (`DISPATCHER_QUESTIONS.conflict_risk`, role `dispatcher`), with bounded, redacted briefs and no diffs. Only a probability above `CONFLICT_TRIAGE_THRESHOLD` (0.5) starts an investigation; a failed call dismisses the pair, because without shared files there is no deterministic reason to spend a Sandbox.
3. **Investigate (Dispatcher harness).** For each flagged pair, a read-only Sandbox (`conflict-<watch>-<train>`) gets read access to both Train repositories and no model access. It trial-merges the other Train's head into this Train's head without committing (`checkoutTrialMerge`), and on a clean merge runs the network's trusted validation. Secrets and history are then removed and repository access dropped; only the Dispatcher model stays reachable. The Dispatcher harness (capability `investigation`: read and search only) examines the merged checkout, with conflict markers left in place, and answers with `conflictVerdictSchema`, with one in-session correction. A trial merge that conflicts is reported whatever the model concludes.
4. **Report.** A confirmed pair raises `dispatcher.conflict_reported` and appears as a Dispatcher card while both Trains are running. The card can place a user hold on the Train the Dispatcher suggests (usually the one with less done), open either Train, or acknowledge the report. Once either Train unloads or is sided, the report disappears: Terminus integration checks the real merge from then on.

Investigations get two Workflow retries spaced minutes apart, which also covers Sandbox capacity limits. When they run out, the pair is recorded as `failed` and nothing is reported. A pair whose other Train finished first is `skipped`.

## State and events

`conflict_watches` (migration `0023_conflict_watch.sql`) holds one versioned record per Car, with its pairs, Clef answer, investigation, report and acknowledgment. The migration records every existing Car as a baseline watch, so deploying it starts no investigations for old work. Snapshots include `conflictConcerns`: pairs still being investigated and unacknowledged reports between running Trains.

Events: `dispatcher.conflict_investigating`, `dispatcher.conflict_reported`, `dispatcher.conflict_cleared`, `dispatcher.conflict_investigation_failed`, `dispatcher.conflict_acknowledged`. Clef dismissals are recorded on the watch without an event.

```sh
curl -X POST http://localhost:8787/api/networks/NETWORK_ID/conflict-watches/WATCH_ID/OTHER_TRAIN_ID/acknowledge
```

Acknowledging is idempotent and changes no Train, Station, hold or gate. A later Car on either Train can report the pair again.

## Offline behavior

With `ENGINEER_MODEL=fake`, Clef treats Lines that share a directory or contract as related. With `DISPATCHER_MODEL=fake` (or fake repositories), the investigation reads nothing and reports shared files and planned areas only. To see a report offline, lay two Lines whose first Stations expect the same file and whose Lines have more Stations, so both Trains are still running when the report arrives.

## Live verification

Trial merges are covered by Git tests and the Workflow by offline tests. The Clef question, the investigation Sandbox with two read grants, and the Dispatcher's verdicts on real repositories still need a maintainer live check.
