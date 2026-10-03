# Terminus

Terminus coordinates coding agents on concurrent Lines of work. Each Train accumulates accepted Station work; D1 owns the railway state, Artifacts owns repositories, and Workflows coordinate execution. The browser polls snapshots and the domain event log.

The domain, persistence, API and Train/Station Workflows are implemented. Real Artifacts and Sandbox/OpenCode adapters and a model Conductor are available alongside fakes. **Live Cloudflare execution has not yet been verified.** Trains currently stop at `returning`: final integration into Terminus, model-driven planning, and the railway map are future work.

## Local development with fakes

Use Node 24 and npm. No Cloudflare credentials, Docker or model calls are needed for the fake environment.

```sh
npm install
npm run dev:fake
```

In another terminal:

```sh
npm run dev:web
```

Open the URL Vite prints. Create a network and choose **Lay demo Lines**. The two Trains run independently; the Red Line has two ordered Stations, and the Blue Line has one. Fake reviews request one revision by default. Accepted work appears as Cars with events in the status page.

```sh
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build
```

Worker tests run in workerd with D1 and Workflows. Repository transport tests use real, temporary local Git repositories. Model tests use mock transports; they do not incur inference charges. The current workerd Workflow tests can print cancellation messages during teardown even when assertions pass.

## Real repositories and agents

Prerequisites: Docker, Cloudflare access to Artifacts and Sandboxes/Containers, and a public HTTPS Git repository containing an npm project with a committed `package-lock.json`. The sibling `../terminus-demo-app` is the demo baseline; its changes must be committed and made available at a public Git URL by the maintainer before importing it.

1. Authenticate Wrangler and select your Cloudflare account. In `apps/worker/wrangler.jsonc`, set `account_id` if necessary, confirm the Artifacts namespace (`default`), and set `AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_ID`.
2. Configure the `AI_GATEWAY_TOKEN` Worker secret. Despite its name, it is a Cloudflare API token scoped to this account with **Workers AI > Read**, required by the [Cloudflare model REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/). A token with only AI Gateway permissions is insufficient. Model credentials stay in the Worker.
3. For local development, put that secret and any local account/gateway overrides in the ignored `apps/worker/.dev.vars` file. Do not commit it. Start Docker, then run `npm run dev:worker` and `npm run dev:web`.
4. Create a network using the public Git URL field. This imports the project into Artifacts. Choose **Lay demo Lines** to run the demo manifests against that baseline.

Local `.dev.vars` entries have this shape:

```dotenv
AI_GATEWAY_ACCOUNT_ID=YOUR_32_HEX_ACCOUNT_ID
AI_GATEWAY_ID=default
AI_GATEWAY_TOKEN=YOUR_ACCOUNT_SCOPED_WORKERS_AI_TOKEN
```

Both `STATION_AGENT_MODEL` and `CONDUCTOR_MODEL` are configured as **`@cf/zai-org/glm-5.3-flash`** for testing. OpenCode's primary and small-model settings use that same configured identity. The calls use low reasoning effort for testing. There is no automatic fallback to the expensive production models mentioned in the design documents.

The Sandbox image pins OpenCode 1.18.32 and Node 24. The required Sandbox Durable Object is only a container adapter; it stores no orchestration state. Outbound access is limited to its explicitly granted repository, the configured model endpoint, and the npm registry. Repository tokens are short-lived and repo-scoped, and the Worker injects them into Git requests. The Station process receives neither repository tokens nor model secrets. Orchestration uses separate workspaces for writes to a Train.

For a deployed Worker, create/bind the D1 database, configure its `database_id`, apply migrations remotely, set the secret, and deploy from `apps/worker`:

```sh
npx wrangler d1 create terminus
# Copy the returned database_id into wrangler.jsonc before continuing.
npx wrangler d1 migrations apply terminus --remote
npx wrangler secret put AI_GATEWAY_TOKEN
npm run deploy
```

Deployment is a maintainer action. The frontend currently runs separately through Vite; this Worker deployment does not publish the React app. The API currently has no authentication, so use a controlled development environment.

## Execution and evidence

Departure forks the Station repository from the Train's current commit. The Station Sandbox clones it, runs `npm ci`, receives the D1 manifest as context, and executes OpenCode. After the process exits, orchestration commits remaining edits, runs configured validation, and collects actual exit codes, bounded stdout/stderr, changed paths and a binary Git patch. Agent summaries are only context.

Evidence is checkpointed in D1 before the candidate is pushed. A run becomes reusable only after its commit is confirmed in Artifacts. Retries can recover that candidate without another model call. If an unpushed candidate and its Sandbox have both disappeared, the run fails explicitly and requires a new run; it cannot silently attach a Car from incomplete evidence.

The Conductor receives the manifest, actual diff and independent validation. Missing or failed required checks return work without a model call. Structured verdicts are validated and checkpointed in D1 before applying domain commands or moving repository heads, so acceptance retries preserve the original review. Acceptance performs a non-forced fast-forward from the reviewed Train commit, then attaches a Car retaining the accepted commit, diff, evidence, model configuration and review. A moved Train or incompatible history blocks acceptance rather than rewriting history.

Artifacts forks copy the current default branch, so the adapter verifies the requested commit before and after forking. Existing completed forks are reusable on retries; an unavailable historical snapshot fails explicitly.

The current runner supports npm projects and HTTPS/public imports. Dependencies must be retrievable from the npm registry without third-party install downloads. Private imports, arbitrary network access, final Terminus merge integration and deployment authentication are not implemented.

## API examples

Vite proxies `/api` to the Worker at port 8787. Create a network and import a project:

```sh
curl -X POST http://localhost:8787/api/networks \
  -H 'Content-Type: application/json' \
  -d '{"name":"Demo","sourceUrl":"https://github.com/OWNER/DEMO.git"}'
```

Omitting `sourceUrl` creates an initialized empty Artifacts repository. Push an npm baseline into that repository before starting real Station work.

Validation commands are trusted project configuration stored in D1, separate from model-generated manifests. Creation optionally accepts `validation`; defaults are `typecheck` (`npm run typecheck`), `test` (`npm test`), and `build` (`npm run build`). Every configured command is required. Each manifest's `expectedEvidence` must name configured commands; missing names prevent execution. Commands execute as argument arrays, not shell strings.

```sh
curl -X POST http://localhost:8787/api/networks/NETWORK_ID/demo
curl http://localhost:8787/api/networks/NETWORK_ID
curl 'http://localhost:8787/api/networks/NETWORK_ID/events?after=0'
```

Architecture and ownership rules are in [AGENTS.md](./AGENTS.md), [the outline](./docs/outline-updated.md), and [technology architecture](./docs/technology-architecture.md).
