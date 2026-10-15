# API examples

Stop Dispatcher planning with `POST /api/networks/:networkId/plans/:planId/stop`. Cancellation is durable and cleanup can be retried with the same endpoint; see [Stopping planning](dispatcher-planning.md#stopping-planning).

Vite proxies `/api` to the Worker at port 8787. Feature-specific endpoints are documented alongside each feature: [planning](dispatcher-planning.md), [unloading](unloading.md), [previews](previews.md), [integration recovery](terminus-integration.md#conflicts-and-recovery), [Technician repairs](technician.md#api), [Crossings](crossings.md) and [Junctions](junctions.md).

Use **Emergency Brake** in Network Overview or the Terminus tab to stop all Station work in that network and discard unfinished Sandbox contents. Its endpoint is `POST /api/networks/:networkId/emergency-brake` with JSON `{ "discardUnfinishedWork": true }`; see [Emergency Brake](station-execution.md#emergency-brake) for scope, partial failures and recovery. For targeted cleanup, `DELETE /api/stations/:stationId/sandbox` takes JSON `{ "runId": "STATION_ID-s1-r0" }`; see [Station Sandbox cleanup](station-execution.md#stopping-one-leftover-station-sandbox) for Workflow gates and unpublished-candidate protection.

Sandbox limits: `GET`/`PUT /api/settings/sandboxes` reads or saves the General limits as `{ "agent": 25, "agentless": 20, "sizes": { "agent": "standard-3", "agentless": "standard-2" } }`: limits are whole numbers from 1 to 100, and sizes are `standard-1`, `standard-2` or `standard-3` (omitting `sizes` saves the defaults). `GET`/`PUT /api/networks/:networkId/settings/sandboxes` reads `{ override, general, updatedAt }` and saves `{ "override": { "agent": 20, "agentless": 5, "sizes": { "agent": "standard-3", "agentless": "standard-1" } } }`; `{ "override": null }` follows General again. See [Sandboxes and limits](live-setup.md#sandboxes-and-limits).

The explicit [ten-Train stress-test command](pipeline-stress-test.md) creates its own fixture Network, freezes scripted execution for those Trains, and adds resource diagnostics and a canonical Git oracle. The browser uses normal application login; no deployment-wide test mode is needed.

## Browsing accepted changes

Repository overviews and individual files read immutable Artifacts trees and blobs directly in the Worker, without a Sandbox or repository token. Overviews retain the 5,000-file inventory, ranked selection of 40 documents, secret/symlink/submodule exclusions, and 200,000-character document limit. Tree traversal is capped at 1,000 trees and 64 directory levels; incomplete inventories set `filesTruncated`. File-size requests use bounded concurrency, repeated blobs share a size read, and D1 caches each overview by repository and exact commit.

Train and Car panels fetch comparisons from Artifacts on demand. These reads do not write D1 or start a Sandbox. Existing persisted review diffs are retained.

| Read | Endpoint |
| --- | --- |
| Train's changed files | `GET /api/trains/:trainId/changes?base=<terminusBaseline>&head=<headCommit>` |
| Train's file diff | `GET /api/trains/:trainId/changes/file?base=<terminusBaseline>&head=<headCommit>&path=<path>` |
| Car's changed files | `GET /api/trains/:trainId/cars/:carId/changes?base=<sourceCommit>&head=<acceptedCommit>` |
| Car's file diff | `GET /api/trains/:trainId/cars/:carId/changes/file?base=<sourceCommit>&head=<acceptedCommit>&path=<path>` |

The Worker checks both commits against recorded provenance. A stale Train comparison returns `409`; an unknown Train, Car from another Train, or unchanged/excluded file returns `404`. Copied Cars use their preserved original commit pair in the receiving Train repository. Train comparisons include all accepted work since the frozen Terminus baseline, including Crossings and released Junction work, rather than comparing against today's Terminus head.

File lists contain `path`, `kind` (`added`, `deleted`, `modified`), and before/after Git modes. File diffs return unified `hunks` and a `status` of `text`, `binary`, `too_large`, or `unsupported` (symlink/submodule). Known credential paths are excluded. Listing stops at 5,000 files, 1,000 tree reads, or 64 directory levels, with `filesTruncated: true`. Inline diffs limit each file to 128,000 bytes and 10,000 lines, with bounded comparison time and edit distance; oversized changes return no partial patch. Renames appear as deletion plus addition.

Successful responses allow private browser caching by exact commits. The UI keeps bounded session caches and loads file contents only when that file is expanded. Offline mode shows explicitly illustrative changes.

## Permanently deleting a network

Network Overview's **Network actions** kebab menu contains **Emergency Brake** and **Delete Network**. Delete requires confirmation and calls `DELETE /api/networks/:networkId` with JSON `{ "confirm": true }`.

Deletion fences the Network against new commands and persisted writes, terminates and deletes all of its Train, Station, Dispatcher, Junction, integration, and Technician Workflow instances, and destroys its registered containers (including random Git, review, planning and repair sessions and previews). It then deletes every Artifacts repository in the Network's namespace, including unrecorded fork candidates, and atomically erases all Network-owned D1 records, events, evidence, reviews, settings and resource identities. General settings and other Networks are preserved. Nothing is archived; there is no undo. Artifacts repository deletion returns `202 Accepted` and the provider finishes removal asynchronously; the API does not expose namespace deletion, so its empty namespace remains.

Successful deletion returns `204`, including repeated requests after removal. A cleanup failure returns `503` and leaves the Network fenced with `deleting: true` in its summary. Retry **Delete Network** to finish; external resources may already have been deleted. The remaining records exist only to finish cleanup and are erased on success.

Before deploying migration `0015_network_deletion.sql`, drain existing Workflows and clean up leftover random Git, Conductor, Dispatcher, Technician, Station and preview containers. Older code did not persist their identities, so they cannot be attributed safely to a Network retroactively. All sessions started by the new code, including Station runs and previews, register ownership before starting a container. Deletion purges only those registered Sandboxes, at the sizes each one started. It never addresses a Sandbox by a reconstructed Station or preview name, because purging an address that never ran still wakes its containers' Durable Objects. Verify deletion of a disposable live Network with every role and preview active before relying on it in production; offline tests never call providers.

## Creating a network

Create a network and import a project:

```sh
curl -X POST http://localhost:8787/api/networks \
  -H 'Content-Type: application/json' \
  -d '{"name":"Demo","sourceUrl":"https://github.com/OWNER/DEMO.git"}'
```

Omitting `sourceUrl` creates an initialized empty Artifacts repository in a new namespace. Push an npm baseline into that repository before starting real Station work.

## Validation commands

Validation commands are trusted project configuration stored in D1, separate from model-generated manifests. Creation optionally accepts `validation`; defaults are `typecheck` (`npm run typecheck`), `test` (`npm test`), and `build` (`npm run build`). Every configured command is required. Each manifest's `expectedEvidence` must name configured commands; missing names prevent execution. Commands execute as argument arrays, not shell strings.

## Demo Lines, snapshots and events

```sh
curl -X POST http://localhost:8787/api/networks/NETWORK_ID/demo
curl http://localhost:8787/api/networks/NETWORK_ID
curl 'http://localhost:8787/api/networks/NETWORK_ID/events?after=0'
curl http://localhost:8787/api/networks/NETWORK_ID/integrations
```

## Engineer notices

Network snapshots optionally include `engineerNotices`: unresolved, unacknowledged advisory notices. Each identifies its Train, relevant Station/dependencies, factual summary and assessment time; dependency notices also include `waitingSince`. The backend resolves obsolete notices and retains their lifecycle in the ordinary event log.

`POST /api/networks/:networkId/engineer-notices/:noticeId/acknowledge` acknowledges a notice and returns its metadata. Repeating the request is safe, including after resolution. An unknown network or a notice belonging to another network returns 404. Acknowledgment does not change any Train, Station, hold or gate.

Engineer notices do not start planning or recovery. Actual blockers and required approvals remain visible through their existing Dispatcher cards.

Network snapshots optionally include `conflictConcerns`: Dispatcher conflict checks still running and unacknowledged conflict reports between running Trains (see [Conflict watch](conflict-watch.md)). `POST /api/networks/:networkId/conflict-watches/:watchId/:otherTrainId/acknowledge` acknowledges one report and returns the watch. It is idempotent, returns 404 for an unknown network or a watch in another network, and changes no Train, Station, hold or gate.
