# Station execution and evidence

How a Station's work is produced, independently validated, reviewed by the Conductor, and attached to its Train as a Car.

## Running a Station

Departure forks the Station repository from the Train's current commit. The Station Sandbox clones it, runs `npm ci`, receives the D1 manifest as context, and executes its frozen harness configuration. After the process exits, orchestration commits remaining edits, runs configured validation, and collects actual exit codes, bounded stdout/stderr, changed paths and a binary Git patch. Agent summaries are only context.

Evidence is checkpointed in D1 before the candidate is pushed. A run becomes reusable only after its commit is confirmed in Artifacts. Retries can recover that candidate without another model call. If an unpushed candidate and its Sandbox have both disappeared, the run fails explicitly and requires a new run; it cannot silently attach a Car from incomplete evidence.

## Emergency Brake

**Emergency Brake** is available in Network Overview and the map's **Terminus** tab. Confirm **Stop Stations & Discard Work** to stop every Station run in the selected network and delete its disposable Sandbox contents, including containers left behind by earlier attempts and retries. No container IDs or browser console commands are needed.

The backend atomically records a network hold and explicit interruption requests before terminating Station Workflows and closing their Sandboxes. The owning Train Workflows apply those requests as blockers; an interruption never asks the Engineer to retry or accepts a late result. Accepted Cars, Artifacts repositories and existing evidence stay in history. Unfinished local files and unpublished Git objects are discarded. Dispatcher, Conductor, integration, Technician and preview containers are outside this control; they can still occupy capacity.

The dialog reports per-run cleanup failures and can safely retry. If a request fails or the browser disconnects, the durable hold and interruption requests remain; run Emergency Brake again to finish cleanup. The reported count includes historical runs whose containers were already stopped. In Cloudflare's Containers dashboard, verify the affected `station-…` instances are **Stopped** before resuming. Release the Emergency Brake hold under **Holds** on the Network Map, then use **Retry Station after intervention** for interrupted Trains.

The authenticated endpoint is `POST /api/networks/:networkId/emergency-brake` with JSON `{ "discardUnfinishedWork": true }`. It returns `{ "holdId", "cleanedUpRunIds", "failures": [{ "runId", "detail" }] }`; partial failures retain the hold and return these details. The fake environment applies the same lifecycle commands and terminates fake Station Workflows without starting any containers. No D1 migration is required.

## Stopping one leftover Station Sandbox

Failed runs without a checkpointed candidate close their Sandbox before retrying. Successful publication closes it too. An unpublished candidate (including an uncertain evidence-write acknowledgement) retains its Sandbox for recovery. Every execution Sandbox installs a 30-minute inactivity timeout before configuring outbound interception.

To stop a leftover Sandbox, use `DELETE /api/stations/:stationId/sandbox` with JSON `{ "runId": "STATION_ID-s1-r0" }`. This uses the app's existing Cloudflare Access authentication and same-origin mutation protection. Only a `complete`, `errored`, or `terminated` Station Workflow can be cleaned up; running, queued, waiting, paused, and unknown instances return `409`. Cleanup does not start a container or change any Train, Station, Artifacts repository, or D1 record. Success returns `204`, and repeated cleanup is safe.

An unpublished evidence checkpoint also returns `409`. For disposable demo work only, explicitly include `"discardUnpublishedCandidate": true` to stop the Sandbox despite that checkpoint. This deletes local files and Git objects that might be needed to publish the candidate; it does not mark that candidate published or delete its evidence.

From the browser's developer console while signed into Terminus:

```js
const stationId = "STATION_ID"
const response = await fetch(`/api/stations/${encodeURIComponent(stationId)}/sandbox`, {
  method: "DELETE",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ runId: `${stationId}-s1-r0` }),
})
console.log(response.status, response.status === 204 ? "Stopped" : await response.text())
```

Use the full container name from Cloudflare with its leading `station-` removed as `runId`. If a failed run's Workflow is still active, finish or explicitly terminate that exact `terminus-station` instance before cleanup. Termination interrupts reporting to the Train, so use the app's intervention flow afterward if its Train is still awaiting an outcome. Pausing a Workflow alone does not stop its container. Verify the instance shows `Stopped` in the Containers dashboard before restarting work; stopped instances do not consume running-instance capacity. Do not use `wrangler containers delete`, which deletes the entire application.

## Revisions and retries

Station work receives one initial attempt and at most **three automatic revisions** by default. Failed required checks, Conductor returns and the Engineer's retries of failed Station runs share this allowance. Within it, the Engineer's Clef model may retry a failed run (immediately or after a pause) when confident the failure won't recur, and may stop a revision loop early when confident more revisions won't help; when it is unsure or unavailable, a failed run blocks and returned work is revised, as before. If work is still rejected after the third revision, the deterministic Engineer blocks the Station and Train and raises an issue to the Dispatcher. The Dispatcher records `dispatcher.user_attention_requested` in the same atomic D1 batch and displays a persistent **User attention needed** alert above the planning panel. No further Station run starts automatically. The latest rejected candidate, repository reference, review feedback and independently collected evidence remain inspectable; earlier runs and reviews stay in history.

Configure the allowance with the `STATION_MAX_RETRIES` Worker var (default `3`, nonnegative integer; `0` disables automatic revisions). This bounds Station revisions, separately from Workflow retries of an interrupted infrastructure step. After intervention, **Retry Station after intervention** (or the existing Train clear endpoint) grants a fresh allowance and forks a new workspace from the Train's accepted state. The latest review feedback is passed to the new run, and the lifetime revision count and previous evidence are retained. Configuration changes require restarting the local Worker or redeploying through the maintainer workflow. No D1 migration is needed for this policy; older Station records use their existing revision count until explicitly restarted.

## Conductor review

The Conductor receives the manifest, actual diff and independent validation. Missing or failed required checks return work without a model call. In live mode the Conductor uses its frozen harness configuration in its own Sandbox, reviewing a sealed checkout of the exact candidate commit, which already contains the Train's accepted Cars. Orchestration runs `npm ci` there before the model is reachable, then removes secret files, Git history and repository access. The Conductor reads the changed files and what depends on them, builds the project, runs checks, and starts the app in the background to exercise the changed behavior over HTTP before it decides. It has no editing tools and no write access to any repository. If it changes tracked files anyway, its review is discarded. Expect a review to take several minutes; the Train stays `reviewing` meanwhile. A review that fails, or still returns an invalid verdict after two corrections in the same session, blocks the Train and Station for intervention, as before. With fake repositories, the configured Conductor model reviews the supplied diff directly.

Crossing handoffs, Junction input and feature acceptance, and Technician repairs are reviewed the same way, each against its own candidate: the merge candidate, the Junction head, or the repair workspace. Each review gets its own Workflow step, so expect those to take minutes too.

Structured verdicts are validated and checkpointed in D1 before applying domain commands or moving repository heads, so acceptance retries preserve the original review. Acceptance performs a non-forced fast-forward from the reviewed Train commit, then attaches a Car retaining the accepted commit, diff, evidence, model configuration and review. A moved Train or incompatible history blocks acceptance rather than rewriting history.

## Constraints

Artifacts forks copy the current default branch, so the adapter verifies the requested commit before and after forking. Existing completed forks are reusable on retries; an unavailable historical snapshot fails explicitly.

The current runner supports npm projects and HTTPS/public imports. Dependencies must be retrievable from the npm registry without third-party install downloads. Private imports, arbitrary network access and deployment authentication are not implemented.

Validation commands are trusted project configuration stored in D1, separate from model-generated manifests; see [API examples](api.md#validation-commands).
