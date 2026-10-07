# Deploying a private beta

This is a disposable, single-maintainer deployment. One Worker serves the built React app, `/api/*`, and the existing Workflows/Sandbox adapter. D1 stores metadata; each managed project uses an Artifacts namespace. Cloudflare Access is the authentication boundary. No application accounts or additional infrastructure are required.

The checked-in config disables Cloudflare deployment/version preview URLs (`preview_urls: false`) and explicitly keeps the regular `workers.dev` URL enabled. **Preview Train** and **Preview Terminus** are separate application features; their wildcard hostnames are configured below.

## 1. Prepare Cloudflare and Docker

- Use Node 24 and install dependencies with `npm ci` from the repository root.
- Start Docker; Wrangler builds and publishes the execution image from `apps/worker/Dockerfile`.
- Use a Cloudflare account with Workers Paid, Artifacts and Sandboxes/Containers available, and create an AI Gateway (the default configured name is `default`).
- Enable Cloudflare Zero Trust so you can configure Access.
- Use a public HTTPS Git URL for the committed demo project. Importing private source repositories is outside the current scope.

Run these from `apps/worker`:

```sh
npx wrangler login
npx wrangler whoami
npx wrangler d1 create terminus
```

If you already created the remote `terminus` D1 database, reuse it. Copy its `database_id` into the top-level `d1_databases` entry in `wrangler.jsonc`. Do not put the remote ID into `env.fake`.

Set these non-secret values in the same config:

- `account_id` at the top level, especially if you have multiple accounts.
- `vars.ARTIFACTS_ACCOUNT_ID` and `vars.AI_GATEWAY_ACCOUNT_ID` to your account ID.
- `vars.AI_GATEWAY_ID` to your Gateway's name.
- Leave `vars.APP_ORIGIN` empty for the initial deployment: public control app/API requests will return 503 until you configure the origin. Local development still works.

Keep the role vars on `settings` and the app's model preset on **Extra-light** for testing. There is no automatic model fallback.

## 2. Configure secrets and apply migrations

Create account-scoped Cloudflare API tokens with the permissions documented in the README:

- `ARTIFACTS_API_TOKEN`: Artifacts Read and Edit.
- `AI_GATEWAY_TOKEN`: Workers AI Read (AI Gateway permissions alone are insufficient).

From `apps/worker`:

```sh
npx wrangler secret put ARTIFACTS_API_TOKEN
npx wrangler secret put AI_GATEWAY_TOKEN
npx wrangler d1 migrations apply terminus --remote
```

Paste each token at Wrangler's prompt. Local `.dev.vars` are not deployed; remote secrets must be set separately. Keep tokens out of the committed config.

## 3. Bootstrap the Worker, protect it, then enable the app

From the repository root:

```sh
npm run deploy
```

The Wrangler custom build builds the React app first and publishes its assets with the Worker. The Workflows and container configuration deploy with it. With `APP_ORIGIN` still empty and no preview domain configured, the public HTTP app/API remain unavailable.

In **Workers & Pages → terminus → Access**, choose **Protect this Worker behind Access → All traffic**. Configure an Allow policy that includes only your exact email; review/edit the policy in Zero Trust if the initial dialog offers broader account/domain choices. Worker-level protection covers routes, custom domains and the regular `workers.dev` URL. Do not add a bypass policy. See [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).

Set `vars.APP_ORIGIN` to the exact HTTPS URL printed by deployment, without a path, for example:

```jsonc
"APP_ORIGIN": "https://terminus.YOUR_SUBDOMAIN.workers.dev"
```

Run `npm run deploy` again. Open that URL and sign in. In a private/logged-out browser, confirm both `/` and `/api/networks` require Access authentication and do not expose app data.

If you prefer a custom app domain, add its Worker Custom Domain, set `APP_ORIGIN` to that origin, and set `workers_dev: false` so the unused regular URL is disabled. Keep `preview_urls: false`.

## 4. Enable Train and Terminus application previews

The app and agents work without this setup, but **Preview Train** / **Preview Terminus** need it for full testing.

Use a dedicated preview domain, ideally a different registrable domain from the control app. Each snapshot is served at `preview-<snapshot>-<token>.<preview-domain>`.

1. Add proxied wildcard DNS for `*.<preview-domain>` in its Cloudflare zone. For a dedicated zone apex, Cloudflare's documented example is an `AAAA` record named `*`, value `100::`, with proxying enabled. The Worker route handles requests before any origin connection.
2. Ensure TLS covers that wildcard. A wildcard immediately under the zone apex is the simplest shape; a hostname such as `*.previews.example.com` needs a certificate covering that additional depth. Follow [Cloudflare's preview hostname setup](https://developers.cloudflare.com/sandbox/previews/serve-previews-on-their-own-hostnames/).
3. Add a Worker route for `*.<preview-domain>/*` to `terminus`. If storing it in Wrangler, use the `routes` array; for example:

   ```jsonc
   "routes": [
     { "pattern": "*.example-previews.com/*", "zone_name": "example-previews.com" }
   ]
   ```

4. Set `vars.PREVIEW_BASE_URL` to `https://<preview-domain>` and deploy again. Keep `workers_dev: true` when the control app uses its regular Worker URL.
5. Verify the Worker-level Access policy protects an actual generated preview URL in a logged-out browser. If using hostname-based Access instead, add a separate application protecting the entire preview wildcard and allow only your email.

Preview hostnames route only to their preview app, even for `/api/*` and paths that match Terminus assets. The preview domain's apex and malformed preview subdomains return 404. Cookies, Authorization and Cloudflare Access headers are removed before requests enter the preview container. Control API browser commands from foreign origins are refused.

## 5. Smoke test and subsequent updates

- Import the demo repository, lay two concurrent Lines, and confirm both accumulate Cars and integrate.
- Test human unloading approval and reopen the app while work is running.
- Open Train and Terminus previews; confirm they show the selected accepted commits.
- Watch failures with `npx wrangler tail` from `apps/worker`, and inspect Workflow/container status in the dashboard.

The shared execution container cap is six; previews and Git/validation work share it with Station agents. Start with two concurrent Lines and avoid many simultaneous previews.

Before an update, run the normal checks from the repository root:

```sh
npm run typecheck
npm test
npm run lint
npm run format:check
```

Apply any new migrations remotely from `apps/worker`, then run `npm run deploy` from the root. Deploying may interrupt running execution when container code/images change; finishing your current test first is simplest for this disposable beta. Deployment does not automatically wipe D1.

If you deliberately reset D1, first terminate old Workflow instances and stop their containers. A database reset alone does not stop execution or remove managed Artifacts repositories/namespaces. Reimport into a fresh project and clean up old resources separately.
