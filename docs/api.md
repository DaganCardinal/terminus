# API examples

Vite proxies `/api` to the Worker at port 8787. Feature-specific endpoints are documented alongside each feature: [planning](dispatcher-planning.md), [unloading](unloading.md), [previews](previews.md), [integration recovery](terminus-integration.md#conflicts-and-recovery), [Technician repairs](technician.md#api), [Crossings](crossings.md) and [Junctions](junctions.md).

Use **Emergency Brake** in Network Overview or the Terminus tab to stop all Station work in that network and discard unfinished Sandbox contents. Its endpoint is `POST /api/networks/:networkId/emergency-brake` with JSON `{ "discardUnfinishedWork": true }`; see [Emergency Brake](station-execution.md#emergency-brake) for scope, partial failures and recovery. For targeted cleanup, `DELETE /api/stations/:stationId/sandbox` takes JSON `{ "runId": "STATION_ID-s1-r0" }`; see [Station Sandbox cleanup](station-execution.md#stopping-one-leftover-station-sandbox) for Workflow gates and unpublished-candidate protection.

Sandbox limits: `GET`/`PUT /api/settings/sandboxes` reads or saves the General limits as `{ "agent": 10, "agentless": 10, "sizes": { "agent": "standard-2", "agentless": "standard-2" } }`: limits are whole numbers from 1 to 100, and sizes are `standard-1`, `standard-2` or `standard-3` (omitting `sizes` saves the defaults). `GET`/`PUT /api/networks/:networkId/settings/sandboxes` reads `{ override, general, updatedAt }` and saves `{ "override": { "agent": 20, "agentless": 5, "sizes": { "agent": "standard-3", "agentless": "standard-1" } } }`; `{ "override": null }` follows General again. See [Sandboxes and limits](live-setup.md#sandboxes-and-limits).

Temporary benchmark logging: `GET /api/perf-logs?from=<ISO time>&to=<ISO time>` returns `{ from, to, invocations, complete, records }`, the `[perf]` lines stored by the perf Tail Worker, oldest first. `to` defaults to now and `from` to an hour earlier; a window may span six hours. `complete` is false when the window held more stored objects than one request reads. See [Deployment](live-setup.md#deployment).

## Permanently deleting a network

Network Overview's **Network actions** kebab menu contains **Emergency Brake** and **Delete Network**. Delete requires confirmation and calls `DELETE /api/networks/:networkId` with JSON `{ "confirm": true }`.

Deletion fences the Network against new commands and persisted writes, terminates and deletes all of its Train, Station, Dispatcher, Junction, integration, and Technician Workflow instances, and destroys its registered containers (including random Git, review, planning and repair sessions and previews). It then deletes every Artifacts repository in the Network's namespace, including unrecorded fork candidates, and atomically erases all Network-owned D1 records, events, evidence, reviews, settings and resource identities. General settings and other Networks are preserved. Nothing is archived; there is no undo. Artifacts repository deletion returns `202 Accepted` and the provider finishes removal asynchronously; the API does not expose namespace deletion, so its empty namespace remains.

Successful deletion returns `204`, including repeated requests after removal. A cleanup failure returns `503` and leaves the Network fenced with `deleting: true` in its summary. Retry **Delete Network** to finish; external resources may already have been deleted. The remaining records exist only to finish cleanup and are erased on success.

Before deploying migration `0015_network_deletion.sql`, drain existing Workflows and clean up leftover random Git, Conductor, Dispatcher and Technician containers. Older code did not persist their identities, so they cannot be attributed safely to a Network retroactively. Named Station runs and historical previews can be reconstructed; all sessions started by the new code register ownership before starting a container. Verify deletion of a disposable live Network with every role and preview active before relying on it in production; offline tests never call providers.

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
