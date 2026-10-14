# Terminus

Terminus coordinates coding agents on concurrent Lines of work. Each Train accumulates accepted Station work; D1 owns the railway state, Artifacts owns repositories, and Workflows coordinate execution. The browser polls snapshots and the domain event log.

## Status

- **Implemented and live-verified:** the domain, persistence, API, Train/Station/Terminus integration Workflows, React/SVG railway map, and real Artifacts and Sandbox harness adapters (OpenCode by default) alongside fakes. The maintainer verified two concurrent Trains reaching and integrating into Terminus in a live test.
- **Implemented, awaiting live verification:** Dispatcher planning (read-only exploration → persisted proposal → explicit launch), sandboxed Conductor reviews, Technician reconciliation of failed Terminus merges, commit-bound human unloading approval, and the Engineer's Clef decisions on failed Station runs and revision loops.

## Quick start with fakes

Use Node 24 and npm. No Cloudflare credentials, Docker or model calls are needed for the fake environment.

```sh
npm install
npm run dev:fake
```

In another terminal:

```sh
npm run dev:web
```

Open the URL Vite prints. Create a network and choose **Lay demo Lines**. The two Trains run independently; the Red Line has two ordered Stations, and the Blue Line has one. Fake reviews request one revision by default. Accepted work appears as Cars with events in the status page. Returning Trains integrate one at a time and finish at `unloaded`. Red unloads automatically; Blue waits in the review yard until you approve its accepted changes.

The Dispatcher also offers **Lay Crossing demo** and **Lay Junction demo** in a fresh network.

## Checks

```sh
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build
```

Worker tests run in workerd with D1 and Workflows. Repository transport tests use real, temporary local Git repositories. Model tests use mock transports; they do not incur inference charges. The current workerd Workflow tests can print cancellation messages during teardown even when assertions pass.

## Ten-Train stress test

```sh
npm run stress:ten
```

This runs the local ten-Train Workflow rehearsal and real local Git oracle, without Cloudflare credentials or Docker. For full Cloudflare verification, open **Stress test** from the app's Networks page, run the test, then **Verify and download report**. It creates its own fixture Network and uses your existing browser login. No manual project import, stress-mode switch, or terminal Access token is needed. See [the run guide](docs/pipeline-stress-test.md).

## Real repositories and agents

Live execution needs Docker, Cloudflare access to Artifacts and Sandboxes/Containers, two Worker secrets (`ARTIFACTS_API_TOKEN`, `AI_GATEWAY_TOKEN`), and a public HTTPS Git repository containing an npm project. Put local secrets in the ignored `apps/worker/.dev.vars`, start Docker, then run `npm run dev:worker` and `npm run dev:web`. Role harnesses and models are chosen in **Settings → Agents**; the default preset uses `@cf/zai-org/glm-5.3-flash` for every role.

See [Live setup](docs/live-setup.md) for token permissions, `.dev.vars`, harness and provider configuration, troubleshooting and temporary performance logging.

## Deployment

One Worker hosts the React assets, API and Workflows, with separate agent and agentless Sandbox images. Deployment needs Node 24, Docker, a Cloudflare account with Workers Paid and Artifacts/Sandboxes available, an authenticated AI Gateway, and Zero Trust Access. Run `npm ci` from the repository root first. Deployment is a maintainer action.

### Configure account resources

In `apps/worker/wrangler.jsonc`, set `account_id`, `ARTIFACTS_ACCOUNT_ID` and `AI_GATEWAY_ACCOUNT_ID` to your account, and `AI_GATEWAY_ID` to your Gateway. Replace the app/Access origins, audience, preview domain and zone route with your own values; these are specific to each deployment. Do the same for `account_id` in `apps/perf-tail/wrangler.jsonc` while temporary logging remains enabled.

From `apps/worker`, authenticate and create resources you have not already provisioned:

```sh
npx wrangler login
npx wrangler whoami
npx wrangler d1 create terminus
npx wrangler r2 bucket create terminus-dependency-cache
npx wrangler r2 bucket lifecycle add terminus-dependency-cache expire-cache --expire-days 30
```

Copy the returned D1 `database_id` into the top-level `d1_databases` entry, leaving `env.fake` local-only. The dependency bucket holds disposable npm caches; expired entries are rebuilt. Provision and deploy the temporary Perf Tail resources as described in [Live setup](docs/live-setup.md#deployment) before deploying the main Worker.

### Bootstrap and protect the Worker

Configure these Worker secrets; local `.dev.vars` are not deployed:

| Secret | Required value |
| --- | --- |
| `ARTIFACTS_API_TOKEN` | Account-scoped token with Artifacts Read and Edit |
| `AI_GATEWAY_TOKEN` | Account-scoped token with Workers AI Read, plus AI Gateway Run for native Anthropic/OpenAI routes |
| `ACCESS_ALLOWED_EMAILS` | Comma-separated emails permitted to use the app |

For a first deployment, put all three in a temporary `NAME=value` secrets file outside the repository. Leave `APP_ORIGIN`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` empty until Access is configured; public requests fail closed. From the repository root:

```sh
npm run deploy -- --secrets-file /path/outside/repo/terminus-secrets.env
```

The deploy command applies remote D1 migrations, builds the web assets and deploys the Worker, Workflows and both container images. Delete the temporary secrets file afterward. Later deployments retain the stored secrets; change one with `npx wrangler secret put NAME` from `apps/worker`.

Protect the Worker behind Cloudflare Access for all traffic, with an Allow policy limited to the intended emails. Then set:

- `APP_ORIGIN`: the exact public HTTPS origin, without a path.
- `ACCESS_TEAM_DOMAIN`: your `https://YOUR_TEAM.cloudflareaccess.com` origin.
- `ACCESS_AUD`: the Access application's Application Audience tag; multiple configured audiences are comma-separated.

Deploy again and sign in. Verify that logged-out requests to `/` and `/api/networks` require authentication. The Worker independently checks the Access JWT and allowed email; missing configuration returns 503 and rejected credentials return 403. Service tokens have no user email and cannot use this authentication path. Keep `ACCESS_REQUIRED` enabled in live deployments and `preview_urls: false`. Use `workers_dev: true` for the regular Worker URL, or a custom domain with `workers_dev: false`.

Application previews need additional wildcard DNS, TLS, routing and Access protection; see [Previews](docs/previews.md#deployment). Publishing managed project code is a separate explicit action through [Workers Builds](docs/publishing.md).

### Updates and verification

Run the [normal checks](#checks), finish active work before changing container images, then run `npm run deploy`. Migrations apply before deployment; deployment does not reset D1. Resetting D1 alone does not stop Workflows or remove containers and Artifacts repositories.

For a smoke test, import a public npm project, run two concurrent Lines, inspect accepted Cars and both integrations, test human unloading approval, and reload during execution. If previews are configured, verify the selected accepted snapshots and logged-out protection. The default Sandbox limits are ten agent and ten agentless containers; adjust them through Settings rather than assuming a shared fixed cap. See [Harness selection](docs/harness-selection.md#release-verification) for outstanding provider checks.

## Guides

| Guide | Covers |
| --- | --- |
| [Live setup](docs/live-setup.md) | Credentials, agents and models, provider routing, release gate, deployment |
| [Dispatcher planning](docs/dispatcher-planning.md) | Proposing, reviewing and launching plans; removing Stations; recovery |
| [Unloading and human approval](docs/unloading.md) | Auto-unload vs. review yard, commit-bound approval |
| [Station execution](docs/station-execution.md) | Station runs, evidence, revision allowance, Conductor review |
| [Terminus integration](docs/terminus-integration.md) | Clearance, merge/validate/promote, conflicts and recovery |
| [Technician repairs](docs/technician.md) | Reconciling failed Terminus merges |
| [Conflict watch](docs/conflict-watch.md) | Checking each accepted Car against other running Trains before they reach Terminus |
| [Crossings](docs/crossings.md) | Picking up another Line's accepted work |
| [Junctions](docs/junctions.md) | Multi-Line feature convergence before Terminus |
| [Previews](docs/previews.md) | Previewing a Train or Terminus, preview hostnames |
| [Publishing](docs/publishing.md) | Publishing Terminus to a publish repository and deploying it with Workers Builds |
| [API examples](docs/api.md) | Creating networks, validation commands, snapshots and events |
| [Pipeline stress test](docs/pipeline-stress-test.md) | Ten scripted Trains, real Git/Sandbox pipeline, correctness oracle and timing report |
| [Harness selection](docs/harness-selection.md) | Per-role harnesses, frozen configuration, release verification |
| [Browser Run transport gate](docs/browser-run.md) | Passed hosted transport proof, reproducible probes and remaining browser release requirements |

Architecture and ownership rules are in [AGENTS.md](./AGENTS.md), [the outline](./docs/outline-updated.md), and [technology architecture](./docs/technology-architecture.md).
