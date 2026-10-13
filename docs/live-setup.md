# Live setup: real repositories and agents

Running Terminus against real Artifacts repositories and Sandbox agents. For the credential-free fake environment, see the [README](../README.md#quick-start-with-fakes).

## Prerequisites

Docker, Cloudflare access to Artifacts and Sandboxes/Containers, and a public HTTPS Git repository containing an npm project with a committed `package-lock.json`. The sibling `../terminus-demo-app` is the demo baseline; its changes must be committed and made available at a public Git URL by the maintainer before importing it.

## Configure and run

1. Authenticate Wrangler and select your Cloudflare account. In `apps/worker/wrangler.jsonc`, set `account_id` if necessary, and set `ARTIFACTS_ACCOUNT_ID`, `AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_ID`.
2. Configure the `ARTIFACTS_API_TOKEN` Worker secret: a Cloudflare API token scoped to this account with **Artifacts > Read** and **Artifacts > Edit**. Each Network gets its own Artifacts namespace (`terminus-<network id>`), which the Workers binding cannot address because it is fixed to one namespace at deploy time, so Terminus uses the [Artifacts REST API](https://developers.cloudflare.com/artifacts/api/rest-api/). The API token stays in the Worker; Sandboxes only ever receive short-lived, repo-scoped Git tokens.
3. Configure the `AI_GATEWAY_TOKEN` Worker secret. Despite its name, it is a Cloudflare API token scoped to this account with **Workers AI > Read**, required by the [Cloudflare model REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/). A token with only AI Gateway permissions is insufficient. Model credentials stay in the Worker.
4. For local development, put those secrets and any local account/gateway overrides in the ignored `apps/worker/.dev.vars` file. Do not commit it. Start Docker, then run `npm run dev:worker` and `npm run dev:web`.
5. Create a network using the public Git URL field. This imports the project into the network's own Artifacts namespace. Choose **Lay demo Lines** to run the demo manifests against that baseline.

Local `.dev.vars` entries have this shape:

```dotenv
ARTIFACTS_ACCOUNT_ID=YOUR_32_HEX_ACCOUNT_ID
ARTIFACTS_API_TOKEN=YOUR_ACCOUNT_SCOPED_ARTIFACTS_TOKEN
AI_GATEWAY_ACCOUNT_ID=YOUR_32_HEX_ACCOUNT_ID
AI_GATEWAY_ID=default
AI_GATEWAY_TOKEN=YOUR_ACCOUNT_SCOPED_WORKERS_AI_TOKEN
```

## Networks and namespaces

Each project has exactly one network. Creating a network from a source URL that another network already imported (ignoring host case, trailing slashes and `.git`) returns `409` with the existing `networkId` in `details`. Networks created from an empty repository are separate projects. Every repository a network uses (Terminus, Trains, Station runs, integration candidates, Technician workspaces) lives in its namespace, and repository ids are stored as `<namespace>/<name>`.

## Troubleshooting local Wrangler

If local Wrangler 4.147.0 prints repeated `internal error; reference = ...` messages, enable `WRANGLER_LOG=debug` and check the stack. A known local failure points to Miniflare's `observability/collector.worker.js` with `Cannot perform I/O on behalf of a different request` and `I/O type: OutgoingFactory`. Restart with the local collector disabled:

```sh
X_LOCAL_OBSERVABILITY=false WRANGLER_LOG=debug npm run dev:worker
```

This workaround uses Wrangler's local development switch; terminal command/model diagnostics and deployed Worker observability remain available. An HTTP 200 from the model only confirms response headers arrived. Station completion still requires the selected harness to exit successfully, independent validation, publication, and Conductor review.

## Dispatcher launch wake

Dispatcher launch uses the shared `dispatcher-launch` Workflow transport event. Cloudflare rejects dots in transport event types; domain events such as `dispatcher.launch_requested` are separate and retain their existing names. The one-minute D1 gate check remains a fallback for lost wakes. After deploying a transport change, verify it with a newly created plan; older Workflow instances may still use the previous event type and resume through the fallback.

## Agents and models

Role harnesses and models are chosen in **Settings → Agents**: General settings apply to every network, with an optional complete network override. Dispatcher, Conductor, Station Agent and Technician each have an OpenCode, Claude Code or Codex selector; Engineer keeps its Clef model. Presets retain OpenCode. Switching a harness makes the form Custom, preserves compatible models and otherwise shows the cheapest compatible catalog choice before saving. Older settings retain their models and default to OpenCode. The default Extra-light preset keeps every text role on **`@cf/zai-org/glm-5.3-flash`**. Settings remain in D1 (`0010_model_settings.sql`). No arbitrary model IDs or runtime provider/model fallback are supported.

New work freezes its execution configuration in the same D1 transaction as creation (`0014_execution_configs.sql`): Trains own every Station run and revision; plans own Dispatcher configuration; repairs own Technician and repair-review configuration; Junctions own their input and feature reviews. Changing settings affects newly created work. Cached Workflow steps and historical model-only provenance remain readable as OpenCode. `STATION_AGENT_MODEL`, `CONDUCTOR_MODEL`, `DISPATCHER_MODEL`, `TECHNICIAN_MODEL` and `ENGINEER_MODEL` set to `fake` run without model access for every settings combination.

The Sandbox image pins OpenCode **1.18.32**, Claude Code **2.1.280**, Codex **0.156.1** and Node 24. Preparation checks the installed CLI version before execution. OpenCode's internal snapshots remain disabled because their Git subprocesses reproduced a local Sandbox hang. Terminus independently captures candidate commits, diffs and validation after process exit. The required Sandbox Durable Object remains only a container adapter. Outbound access stays limited to explicitly granted repositories, one exact provider endpoint/model, and the npm registry; repository write grants have not changed.

See [Per-role harness selection](harness-selection.md) for compatibility, frozen configuration and runtime controls.

## Sandboxes and limits

Two kinds of Sandbox run in separate containers. Agent Sandboxes (`ExecutionSandbox`, `apps/worker/Dockerfile`) run every harness: Station work, Conductor reviews, Dispatcher planning and Technician repairs. Agentless Sandboxes (`WorkspaceSandbox`, `apps/worker/Dockerfile.workspace`) run Git operations, integration validation and previews; their image has no harness, and they refuse model access.

Callers address Sandboxes through `ExecutionSandbox` and `WorkspaceSandbox`, which hold no container. Each routes to a container class of the network's chosen size: `ExecutionSandboxStandard1`–`3` and `WorkspaceSandboxStandard1`–`3`, one per instance type (standard-1, standard-2, standard-3), all built from their kind's image. Every size's container shares its Sandbox's name (such as `station-<runId>`), which is what the Containers dashboard shows. A Sandbox keeps the size of a running container and picks up a changed setting only once its container has stopped, so a size change never strands running work. Registration records the routing Sandbox, and deleting a network purges every size behind it.

**Settings → Sandboxes** sets each kind's instance size (default standard-2 for both: agentless Sandboxes run project validation, which on standard-1 takes about five times as long) and how many of each kind one network may run at once (default 10 agent and 10 agentless, from 1 to 100). General limits apply to every network, with an optional complete network override, like Settings → Agents. Limits are stored in D1 (`0018_sandbox_limits.sql`) and enforced when a container starts: it takes a lease in `sandbox_leases` with one conditional insert, and releases it when it stops. A lease whose Sandbox disappeared lapses shortly after its container would have idled out. At the limit, Workflow work waits up to 10 minutes for a slot, then fails its step, which retries. A preview reports the limit (`503`) instead of waiting. Lowering a limit never stops running Sandboxes, and every size counts toward its kind's limit. Limits saved before sizes existed use the default sizes. `max_instances` in `wrangler.jsonc` (100 per class) is only the platform ceiling and must match `MAX_SANDBOX_INSTANCES` in `packages/protocol/src/sandbox.ts`.

## Provider routing

Every provider routes through AI Gateway. Anthropic/OpenAI calls are paid with [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/): enable an [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/), load credits, leave **Require provider credentials** off, and store no Anthropic/OpenAI key under the **default** alias in Provider Keys (a stored `default` key takes precedence over Unified Billing). Set gateway spend limits to cap paid work. Keep the account-scoped Gateway token in the existing `AI_GATEWAY_TOKEN` Worker secret, with **AI Gateway > Run** for native provider routes and **Workers AI > Read** for the existing Workers AI route. Terminus never receives or stores provider keys, chooses key aliases or changes gateway billing. The outbound handler removes placeholder provider authentication and caller-supplied gateway headers, injects trusted Cloudflare authentication, preserves streaming, and refuses redirects or different endpoints/models (only the role model and its same-provider utility model are accepted). A streamed Workers AI call that has no response headers after 8 seconds is sent once more without session affinity, because stalls queue at the instance the affinity routes to; the first successful response wins, the other is aborted, and `model.call` records `hedgedAtMs` and `winner`. Workers AI requests also carry an `x-session-affinity` derived from the Sandbox's own identity (caller values are dropped), so every turn of a harness session reaches one model instance and its repeated prompt prefix is served from [prefix caching](https://developers.cloudflare.com/workers-ai/features/prompt-caching/): faster prefill, and cached input is billed at the discounted rate. Cache hits appear as cached tokens in the model's `usage`.

Repository heads (fork checks and canonical-head reads) are read from the Worker over Git's smart-HTTP ref advertisement with a short-lived read token, so they start no Sandbox. Read-only checkouts that delete `.git` afterwards (Dispatcher, Conductor, previews) clone at depth 1 when the requested commit is the branch tip, and fall back to a full clone otherwise.

**Release gate:** `ALTERNATIVE_HARNESSES_ENABLED` is `true` in the real deployment, so Settings offers Claude Code, Codex and Anthropic/OpenAI models. Setting it to `false` disables those settings and fails closed if such execution is requested. Fake mode offers all selectors without calling any provider. Migration 0014 must be applied first. The maintainer-owned [harness verification checklist](harness-selection.md#release-verification) is still outstanding. No new-provider live calls are authorized by the existing GLM-only testing instruction.

## Deployment

For the single-maintainer live beta, follow [Private beta deployment](private-beta-deployment.md): bind remote D1, configure both Worker secrets, apply migrations, protect the Worker with Cloudflare Access, and set `APP_ORIGIN` to the exact public HTTPS origin. An empty `APP_ORIGIN` permits local development only. Access is the live authentication boundary; the app has no user accounts.

`npm run deploy` from the repository root builds the React app and publishes it with the API, Workflows and execution container. Cloudflare deployment/version preview URLs are explicitly disabled; Train/Terminus application previews use their own wildcard domain (see [Previews](previews.md)). Deployment is a maintainer action.

**Temporary benchmark logging.** While the speed analysis runs, `terminus` names a Tail Worker, `terminus-perf-tail` (`apps/perf-tail`), that copies every `[perf]` line to the `terminus-perf-logs` R2 bucket, because Workers Logs loses whole invocations. Before the first deploy that includes it, create the bucket and deploy the Tail Worker:

```sh
npx wrangler r2 bucket create terminus-perf-logs
npm run deploy -w @terminus/perf-tail
```

Optionally expire old lines with `npx wrangler r2 bucket lifecycle add terminus-perf-logs perf-expiry perf/ --expire-days 14`. Read a run back from the deployed app with `GET /api/perf-logs?from=<ISO time>&to=<ISO time>` (at most six hours; Access applies). Each record carries its invocation id and the runtime's `outcome` and `truncated` flags, and an invocation that ended badly is recorded even without `[perf]` lines. Remove the app, `tail_consumers`, the `PERF_LOGS` bindings and `/api/perf-logs` with the rest of the perf instrumentation.
