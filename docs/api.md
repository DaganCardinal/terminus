# API examples

Vite proxies `/api` to the Worker at port 8787. Feature-specific endpoints are documented alongside each feature: [planning](dispatcher-planning.md), [unloading](unloading.md), [previews](previews.md), [integration recovery](terminus-integration.md#conflicts-and-recovery), [Technician repairs](technician.md#api), [Crossings](crossings.md) and [Junctions](junctions.md).

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
