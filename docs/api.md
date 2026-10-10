# API examples

Vite proxies `/api` to the Worker at port 8787. Feature-specific endpoints are documented alongside each feature: [planning](dispatcher-planning.md), [unloading](unloading.md), [previews](previews.md), [integration recovery](terminus-integration.md#conflicts-and-recovery), [Technician repairs](technician.md#api), [Crossings](crossings.md) and [Junctions](junctions.md).

Use **Emergency Brake** in Network Overview or the Terminus tab to stop all Station work in that network and discard unfinished Sandbox contents. Its endpoint is `POST /api/networks/:networkId/emergency-brake` with JSON `{ "discardUnfinishedWork": true }`; see [Emergency Brake](station-execution.md#emergency-brake) for scope, partial failures and recovery. For targeted cleanup, `DELETE /api/stations/:stationId/sandbox` takes JSON `{ "runId": "STATION_ID-s1-r0" }`; see [Station Sandbox cleanup](station-execution.md#stopping-one-leftover-station-sandbox) for Workflow gates and unpublished-candidate protection.

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
