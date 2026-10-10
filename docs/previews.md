# Previewing Trains and Terminus

Previews build and serve a Train's or Terminus's exact commit in a read-only Sandbox. They require the [live setup](live-setup.md); the fake environment has no real app to preview and reports this explicitly.

## Previewing a Train

Select a Train on the map and choose **Preview Train** in its drawer. A new browser tab opens while Terminus prepares a separate Cloudflare Sandbox. The preview checks out the Train's exact saved `headCommit`, runs `npm ci` and `npm run build`, and serves the demo app with Vite preview on port 8080. It shows accepted Cars; work still in a Station workspace appears only after Conductor acceptance. The runner is currently hard-coded for the Vite-based `terminus-demo-app`.

Previews have read-only access to that Train repository while cloning, no model access, and no ability to push. Repository access is removed and its token revoked after preparation. Previewing does not change Train state or start its Workflow. Reopening the same accepted snapshot reuses a running Sandbox; a newer accepted commit gets a separate preview. A Sandbox stops after five minutes without requests, or immediately when you choose **Stop preview**. An open preview tab then reports that the preview stopped. Open **Preview Train** again to rebuild a stopped or expired preview.

The API action is `POST /api/trains/TRAIN_ID/preview`. Its response contains `trainId`, the exact preview `commit`, and `url`. Installation/build/startup failures return an error and dispose of the failed Sandbox; they do not block or mutate the Train. `DELETE /api/trains/TRAIN_ID/preview` with `{ "commit": "PREVIEWED_COMMIT" }` stops the preview of that commit and returns 204; stopping an expired or never-started preview is a no-op.

## Previewing Terminus

Select the **Terminus** hub on the map to open its details. The panel shows the current canonical commit and the Trains that have unloaded, with links to their accepted Cars, diffs, and reviews. Choose **Preview Terminus** to build and open the combined application at that exact commit. Before any Train unloads, this previews the imported baseline.

The preview uses the same read-only Sandbox infrastructure and Vite runner as Train previews, with the same hostname setup and five-minute inactivity timeout. It does not advance Trains, reserve integration clearance, change canonical state, or call a model. **Refresh preview** prepares an expired preview again, and **Stop preview** shuts it down immediately.

`POST /api/networks/NETWORK_ID/preview` accepts `{ "commit": "DISPLAYED_TERMINUS_COMMIT" }` and returns `{ "networkId", "commit", "url" }`. A stale displayed commit returns 409 before allocating a Sandbox. A canonical promotion during preparation does not change the preview: it stays pinned to the requested commit. The panel follows the network snapshot; a newer canonical commit requires its own preview, and a late response for an older commit is never shown as the current application. `DELETE /api/networks/NETWORK_ID/preview` with `{ "commit": "PREVIEWED_COMMIT" }` stops that preview and returns 204. Unlike starting, it accepts an older commit, since its preview may still be running after a promotion.

## Hostnames

Local development uses `http://preview-<snapshot>-<token>.localhost:8787/`, routed directly to Wrangler. Docker and the real Worker (`npm run dev:worker`) must be running. If Wrangler runs on another port, set `PREVIEW_BASE_URL=http://localhost:PORT` in `.dev.vars`.

Deployment requires a separate preview domain with wildcard DNS, TLS, and a Worker route. Set `PREVIEW_BASE_URL` to its HTTPS origin, for example `https://example-previews.com`, and route `*.example-previews.com/*` to this Worker. Keep `workers_dev: true` if the control app uses that URL. Protect preview traffic with Cloudflare Access before using it; the preview URL token alone is a bearer link. See [Private beta deployment](private-beta-deployment.md) and Cloudflare's [preview hostname setup](https://developers.cloudflare.com/sandbox/previews/serve-previews-on-their-own-hostnames/) for DNS and certificate details. Each preview has its own browser origin, and all paths on its hostname reach only the preview app, including `/api` and paths matching control-app assets. Access credentials are stripped before forwarding to the container. No domain or route is provisioned by the repository configuration.
