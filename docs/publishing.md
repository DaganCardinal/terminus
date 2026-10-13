# Publishing and deploying Terminus

Publishing makes the current canonical commit available for deployment. Each network can have a **publish repository** in its Artifacts namespace (`terminus-<network id>/publish`). Workers Builds watches that repository and deploys its `main` branch. Terminus itself never holds deployment credentials and never runs a deployment.

Promotion into Terminus does not deploy anything. Integrated work goes live only when someone chooses **Publish**, so the review yard decides what enters Terminus and publishing decides what is live.

## Publishing

Select the **Terminus** hub on the map and choose **Publish snapshot** under **Publishing**. The first publish forks Terminus at the displayed commit into the publish repository. Later publishes fast-forward it to the current canonical commit. They are never forced. The panel shows the published commit and how many Trains have unloaded since.

Publishing changes no Train state, reserves no integration clearance, and calls no model. It records the publication on the network and writes a `terminus.published` event to the activity feed. Deleting the network deletes the publish repository with the rest of its namespace. It does **not** delete the deployed Worker; remove that in the Cloudflare dashboard.

`POST /api/networks/NETWORK_ID/publish` takes `{ "commit": "DISPLAYED_TERMINUS_COMMIT" }` and returns `{ "repoId", "commit", "publishedAt", "siteUrl"? }`. A stale commit returns 409, as it does for previews. Publishing the commit that is already published returns the existing publication unchanged. If the publish repository or Terminus moves while the push is running, the request returns 409; refresh and publish again.

## Connecting Workers Builds

The project needs a Wrangler configuration. `terminus-demo-app` has a `wrangler.jsonc` that deploys the Vite build output (`dist`) as a static-assets Worker. Any project that deploys with `wrangler deploy` works the same way, including server-rendered frameworks that have a Cloudflare adapter.

After the first publish:

1. In the Cloudflare dashboard, open **Workers & Pages → Create application → Continue with Artifacts**.
2. Select the network's namespace (`terminus-<network id>`) and the `publish` repository. The Terminus panel shows both names.
3. Set the build command to `npm run build` and keep the deploy command `npx wrangler deploy`. Then deploy.
4. Copy the Worker's URL into **Add live site URL** in the Terminus panel. It appears as **Open live site** there, and as **Live at** on the network overview.

Workers Builds deploys only the `main` branch, so the source repository you import must use `main` as its default branch. The connection is made once per network in the dashboard; Terminus does not configure Workers Builds.

`PUT /api/networks/NETWORK_ID/publish/site` takes `{ "siteUrl": "https://…" }`, or `null` to clear it. The URL is display information only and requires an existing publication.

## Security notes

- The deployed site is public. Agent-written code reaches it only after an explicit publish, but anyone with the URL can see what is published.
- Workers Builds runs the project's build with credentials that can deploy Workers in the account. Agents can change the project's Wrangler configuration and build scripts, so review what you publish. Consider listing `wrangler.jsonc` as an area to avoid in manifests.
