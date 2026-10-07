# Terminus

Terminus coordinates coding agents on concurrent Lines of work. Each Train accumulates accepted Station work; D1 owns the railway state, Artifacts owns repositories, and Workflows coordinate execution. The browser polls snapshots and the domain event log.

The domain, persistence, API, Train/Station/Terminus integration Workflows, and React/SVG railway map are implemented. Real Artifacts and Sandbox harness adapters (OpenCode by default) and a sandboxed Conductor are available alongside fakes. The maintainer verified both concurrent Trains reaching and integrating into Terminus in a live test. Returning Trains receive Dispatcher clearance, merge and validate against current Terminus, and unload after promotion. Dispatcher planning is implemented: the Dispatcher explores a read-only checkout with OpenCode `explore` subagents, and the goal becomes a persisted proposal that the user reviews and explicitly launches. This new planning path still needs live verification. Technician reconciliation of failed Terminus merges is implemented with durable candidates, independent validation, Conductor review, and explicit approval; it still needs live Artifacts/Sandbox verification. Model-assisted Engineer decisions remain future work.

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

Open the URL Vite prints. Create a network and choose **Lay demo Lines**. The two Trains run independently; the Red Line has two ordered Stations, and the Blue Line has one. Fake reviews request one revision by default. Accepted work appears as Cars with events in the status page. Returning Trains integrate one at a time and finish at `unloaded`. Red unloads automatically; Blue waits in the review yard until you approve its accepted changes.

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

1. Authenticate Wrangler and select your Cloudflare account. In `apps/worker/wrangler.jsonc`, set `account_id` if necessary, and set `ARTIFACTS_ACCOUNT_ID`, `AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_ID`.
2. Configure the `ARTIFACTS_API_TOKEN` Worker secret: a Cloudflare API token scoped to this account with **Artifacts > Read** and **Artifacts > Edit**. Each Network gets its own Artifacts namespace (`terminus-<network id>`), which the Workers binding cannot address because it is fixed to one namespace at deploy time, so Terminus uses the [Artifacts REST API](https://developers.cloudflare.com/artifacts/api/rest-api/). The API token stays in the Worker; Sandboxes only ever receive short-lived, repo-scoped Git tokens.
3. Configure the `AI_GATEWAY_TOKEN` Worker secret. Despite its name, it is a Cloudflare API token scoped to this account with **Workers AI > Read**, required by the [Cloudflare model REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/). A token with only AI Gateway permissions is insufficient. Model credentials stay in the Worker.
4. For local development, put those secrets and any local account/gateway overrides in the ignored `apps/worker/.dev.vars` file. Do not commit it. Start Docker, then run `npm run dev:worker` and `npm run dev:web`.
5. Create a network using the public Git URL field. This imports the project into the network's own Artifacts namespace. Choose **Lay demo Lines** to run the demo manifests against that baseline.

Each project has exactly one network. Creating a network from a source URL that another network already imported (ignoring host case, trailing slashes and `.git`) returns `409` with the existing `networkId` in `details`. Networks created from an empty repository are separate projects. Every repository a network uses (Terminus, Trains, Station runs, integration candidates, Technician workspaces) lives in its namespace, and repository ids are stored as `<namespace>/<name>`.

If local Wrangler 4.147.0 prints repeated `internal error; reference = ...` messages, enable `WRANGLER_LOG=debug` and check the stack. A known local failure points to Miniflare's `observability/collector.worker.js` with `Cannot perform I/O on behalf of a different request` and `I/O type: OutgoingFactory`. Restart with the local collector disabled:

```sh
X_LOCAL_OBSERVABILITY=false WRANGLER_LOG=debug npm run dev:worker
```

This workaround uses Wrangler's local development switch; terminal command/model diagnostics and deployed Worker observability remain available. An HTTP 200 from the model only confirms response headers arrived. Station completion still requires the selected harness to exit successfully, independent validation, publication, and Conductor review.

Local `.dev.vars` entries have this shape:

```dotenv
ARTIFACTS_ACCOUNT_ID=YOUR_32_HEX_ACCOUNT_ID
ARTIFACTS_API_TOKEN=YOUR_ACCOUNT_SCOPED_ARTIFACTS_TOKEN
AI_GATEWAY_ACCOUNT_ID=YOUR_32_HEX_ACCOUNT_ID
AI_GATEWAY_ID=default
AI_GATEWAY_TOKEN=YOUR_ACCOUNT_SCOPED_WORKERS_AI_TOKEN
```

Role harnesses and models are chosen in **Settings → Agents**: General settings apply to every network, with an optional complete network override. Dispatcher, Conductor, Station Agent and Technician each have an OpenCode, Claude Code or Codex selector; Engineer keeps its Clef model. Presets retain OpenCode. Switching a harness makes the form Custom, preserves compatible models and otherwise shows the cheapest compatible catalog choice before saving. Older settings retain their models and default to OpenCode. The default Extra-light preset keeps every text role on **`@cf/zai-org/glm-5.3-flash`**. Settings remain in D1 (`0010_model_settings.sql`). No arbitrary model IDs or runtime provider/model fallback are supported.

New work freezes its execution configuration in the same D1 transaction as creation (`0014_execution_configs.sql`): Trains own every Station run and revision; plans own Dispatcher configuration; repairs own Technician and repair-review configuration; Junctions own their input and feature reviews. Changing settings affects newly created work. Cached Workflow steps and historical model-only provenance remain readable as OpenCode. `STATION_AGENT_MODEL`, `CONDUCTOR_MODEL`, `DISPATCHER_MODEL` and `TECHNICIAN_MODEL` set to `fake` run without model access for every settings combination.

The Sandbox image pins OpenCode **1.18.32**, Claude Code **2.1.280**, Codex **0.156.1** and Node 24. Preparation checks the installed CLI version before execution. OpenCode's internal snapshots remain disabled because their Git subprocesses reproduced a local Sandbox hang. Terminus independently captures candidate commits, diffs and validation after process exit. The required Sandbox Durable Object remains only a container adapter. Outbound access stays limited to explicitly granted repositories, one exact provider endpoint/model, and the npm registry; repository write grants have not changed.

Every provider routes through AI Gateway. For Anthropic/OpenAI BYOK, enable an [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) and add your provider's **default** key under [AI Gateway → Provider Keys](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/). Keep the account-scoped Gateway token in the existing `AI_GATEWAY_TOKEN` Worker secret, with **AI Gateway > Run** for native provider routes and **Workers AI > Read** for the existing Workers AI route. Gateway configuration controls billing; Terminus never receives or stores provider keys, chooses key aliases or changes gateway billing. The outbound handler removes placeholder provider authentication and caller-supplied gateway headers, injects trusted Cloudflare authentication, preserves streaming, and refuses redirects or different endpoints/models.

**Release gate:** `ALTERNATIVE_HARNESSES_ENABLED` defaults to `false`. Real deployments disable alternative harness/provider settings and fail closed if such execution is requested. Fake mode offers all selectors without calling any provider. Apply migration 0014 and deploy with the flag off, drain active legacy work, then complete the maintainer-owned [harness verification checklist](docs/harness-selection.md#release-verification) before enabling it. No new-provider live calls are authorized by the existing GLM-only testing instruction.

For the single-maintainer live beta, follow [Private beta deployment](docs/private-beta-deployment.md): bind remote D1, configure both Worker secrets, apply migrations, protect the Worker with Cloudflare Access, and set `APP_ORIGIN` to the exact public HTTPS origin. An empty `APP_ORIGIN` permits local development only. Access is the live authentication boundary; the app has no user accounts.

`npm run deploy` from the repository root builds the React app and publishes it with the API, Workflows and execution container. Cloudflare deployment/version preview URLs are explicitly disabled; Train/Terminus application previews use their own wildcard domain. Deployment is a maintainer action.

## Previewing Terminus

Select the **Terminus** hub on the map to open its details. The panel shows the current canonical commit and the Trains that have unloaded, with links to their accepted Cars, diffs, and reviews. Choose **Preview Terminus** to build and open the combined application at that exact commit. Before any Train unloads, this previews the imported baseline.

The preview uses the same read-only Sandbox infrastructure and Vite runner as Train previews, with the same local/deployed hostname setup and five-minute inactivity timeout described below. It does not advance Trains, reserve integration clearance, change canonical state, or call a model. Fake mode has no application to preview and reports this explicitly. **Refresh preview** prepares an expired preview again.

`POST /api/networks/NETWORK_ID/preview` accepts `{ "commit": "DISPLAYED_TERMINUS_COMMIT" }` and returns `{ "networkId", "commit", "url" }`. A stale displayed commit returns 409 before allocating a Sandbox. A canonical promotion during preparation does not change the preview: it stays pinned to the requested commit. The panel follows the network snapshot; a newer canonical commit requires its own preview, and a late response for an older commit is never shown as the current application.

## Previewing a Train

Select a Train on the map and choose **Preview Train** in its drawer. A new browser tab opens while Terminus prepares a separate Cloudflare Sandbox. The preview checks out the Train's exact saved `headCommit`, runs `npm ci` and `npm run build`, and serves the demo app with Vite preview on port 8080. It shows accepted Cars; work still in a Station workspace appears only after Conductor acceptance. The runner is currently hard-coded for the Vite-based `terminus-demo-app`.

Previews have read-only access to that Train repository while cloning, no model access, and no ability to push. Repository access is removed and its token revoked after preparation. Previewing does not change Train state or start its Workflow. Reopening the same accepted snapshot reuses a running Sandbox; a newer accepted commit gets a separate preview. A Sandbox stops after five minutes without requests. Open **Preview Train** again to rebuild an expired preview.

Local development uses `http://preview-<snapshot>-<token>.localhost:8787/`, routed directly to Wrangler. Docker and the real Worker (`npm run dev:worker`) must be running. The fake environment reports that it has no real app to preview. If Wrangler runs on another port, set `PREVIEW_BASE_URL=http://localhost:PORT` in `.dev.vars`.

Deployment requires a separate preview domain with wildcard DNS, TLS, and a Worker route. Set `PREVIEW_BASE_URL` to its HTTPS origin, for example `https://example-previews.com`, and route `*.example-previews.com/*` to this Worker. Keep `workers_dev: true` if the control app uses that URL. Protect preview traffic with Cloudflare Access before using it; the preview URL token alone is a bearer link. See [Private beta deployment](docs/private-beta-deployment.md) and Cloudflare's [preview hostname setup](https://developers.cloudflare.com/sandbox/previews/serve-previews-on-their-own-hostnames/) for DNS and certificate details. Each preview has its own browser origin, and all paths on its hostname reach only the preview app, including `/api` and paths matching control-app assets. Access credentials are stripped before forwarding to the container. No domain or route is provisioned by the repository configuration.

The API action is `POST /api/trains/TRAIN_ID/preview`. Its response contains `trainId`, the exact preview `commit`, and `url`. Installation/build/startup failures return an error and dispose of the failed Sandbox; they do not block or mutate the Train.

## Planning work with the Dispatcher

On a network page, expand **Dispatcher**, describe a project goal, and choose **Propose a plan**. The Dispatcher explores a read-only checkout of the exact saved Terminus commit using its configured harness in a Sandbox. With OpenCode it breaks the goal into focused questions and sends them to OpenCode's read-only `explore` subagents in parallel, then reads the files that decide each Station's boundaries. It cannot edit files, run shell commands, or reach the network. Secret files and Git history are removed before it starts, and repository-supplied OpenCode configuration and instruction files are disabled. Planning takes minutes rather than seconds; the proposal is saved when ready, so the panel can be closed.

Turn on **Check baseline first** in the composer to have orchestration install dependencies and run the project's configured checks on that commit before exploring. Results are trusted context for the Dispatcher and appear on the proposal. If a check fails and the goal doesn't already cover it, the Dispatcher suggests a separate **baseline fix** Line. It is included by default; **Reject fix** removes it. When included, every other Line picks up the accepted fix through a Crossing before its first Station. `PUT /api/networks/NETWORK_ID/plans/PLAN_ID/baseline-fix` with `{ "selection": "include" | "reject" }` makes the same choice.

The proposal records **findings**: short facts from exploration with the paths that support them, shown under "What Dispatch explored". They contain no file contents. The backend validates the structured Lines and full Work Manifests and saves the proposal and assessment in D1. Review each Station's scope, expected/avoided areas, contracts, invariants, dependencies, acceptance criteria, and evidence. **Launch Lines** is a separate command; preparing or reopening a proposal does not start Station work. Plans contain at most eight Lines, six Stations per Line, and twenty-four Stations total, including a baseline fix. Model attempts are bounded and never switch models automatically.

If the final message fails schema validation or domain assessment, the field locations and error codes, or the assessment problems, go back into the same native harness session for up to two corrections, so the Dispatcher keeps what it explored. Exhausted schema validation stops Workflow retries and saves safe diagnostics on the failed plan, without raw response values. A proposal that still fails assessment is saved and cannot launch. Transient failures retry the whole planning step once. `expectedAreas` and `avoidAreas` contain only plain paths; put explanations, CSS token restrictions, and other prose in scope or invariants instead. Path patterns and this guidance are included in the model's JSON schema.

Every newly proposed Station must declare `repositoryChange: { kind, description }`, where `kind` is `implementation`, `tests`, `documentation`, or `configuration`, and the description names concrete repository edits. Running existing checks or confirming earlier features coexist belongs in acceptance criteria and expected evidence, rather than a separate Station. Adding or improving test files is valid work. Final merging and project-wide validation already belong to Terminus integration. Invalid declarations use the existing bounded proposal repair loop. Domain assessment refuses launch without a concrete deliverable, and the Engineer rechecks it before signaling; missing declarations on older waiting Stations block the Train and raise a persisted Dispatcher/user alert. Older plans remain inspectable but must be replanned before launch. A declaration is intent, not proof that the eventual diff will be nonempty; the Conductor still reviews independently collected changes.

Waiting or blocked Stations can be removed using **Remove Station** in their details, with a reason, or by posting `{ "reason": "Redundant verification" }` to `/api/networks/NETWORK_ID/stations/STATION_ID/remove`. The deterministic Dispatcher persists the request; the Train Workflow revalidates and applies it. Removal retains the Station as `cancelled` in topology and history, skips it in travel order, and never creates a Car or changes accepted commits. Removing the final Station returns the Train to the Terminus gate. Active/signaled work and accepted Stations cannot be removed. Removal is refused while any unfinished Station, including on another Line, depends on it; cancelled work never satisfies a dependency. Cancel dependents first or explicitly revise the plan. Review blockers belonging to discarded Station work can clear; unrelated conflicts stay blocked and user holds still apply. Lost command wakeups are recovered by periodic gate reads; a request that becomes invalid is recorded as `station.removal_refused` in activity.

Apply `0005_station_removal.sql` before deploying these changes. It protects dependency/removal checks against concurrent topology commands. Local Worker dev applies it automatically; remote migrations use the existing `wrangler d1 migrations apply terminus --remote` command from `apps/worker`.

Code-dependent work must stay on one Line. Dependencies can name only earlier Station keys on that Line; keys are unique across the proposal. Another Line completing a Station does not copy its code into this Train. Contract-based dependencies across planned or active Lines are rejected too. Expected areas use plain repository-relative paths/directories, without globs. Overlaps in declared files/directories or changing contracts are shown as collision forecasts, not stored as Git conflicts. Unknown evidence names or overlaps with avoided areas prevent launch. Forecasting is conservative declared intent; actual diffs, review, and integration checks remain authoritative.

Launch requires the reviewed Terminus baseline still to be current. New collision forecasts also require a fresh proposal. Launch forks stable Train repository identities, then records all Lines, Stations, Trains, the plan, and events in one D1 batch guarded against stale canonical state. Only then does it start the individual Train Workflows. Retries reuse saved proposals and identities. Partial repository preparation can leave unused forks in Artifacts, but never a partially laid network. Closing or refreshing the browser does not stop planning or launch.

The offline environment clearly labels its planner as a simulation: it produces one generic Goal Line, uses fake repositories and checks, and makes no model calls. It exercises the same persisted proposal and launch path. The fixed two-Line demo remains available separately.

For live development, restart the updated Worker so it loads `DISPATCHER_MODEL` and the `DISPATCH_WORKFLOW` binding. Local dev applies `0004_dispatch.sql` automatically. For deployment, apply this migration remotely and deploy the updated Worker through the maintainer workflow. The Dispatcher reuses the existing Gateway credentials and testing model; no additional secret is needed.

API clients submit a UUID `requestId` with each new goal. Reuse it when retrying an uncertain submission; reuse with a different goal/network returns 409. The 202 response includes the saved plan; plans and their states also appear in the network snapshot and their changes in the existing event log.

```sh
curl -X POST http://localhost:8787/api/networks/NETWORK_ID/plans \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"64d6315b-7d66-4e50-94aa-4de0b71029ef","goal":"Add an accessible footer and an independent theme toggle, with tests."}'

curl -X POST http://localhost:8787/api/networks/NETWORK_ID/plans/PLAN_ID/launch
```

If a Dispatcher Workflow is `errored` while a plan remains `planning`, `ready`, `launching`, or `starting`, use **Recover interrupted planning/launch** or the retry endpoint. Recovery restarts the same Workflow and reuses any saved proposal/topology. Finished or failed plans need a new request; a stale proposal cannot be launched against newer canonical code.

```sh
curl -X POST http://localhost:8787/api/networks/NETWORK_ID/plans/PLAN_ID/retry
```

The first live check for this feature is a fresh goal on the demo baseline: inspect the generated manifests and forecasts, confirm no Trains exist before launch, refresh the page, then launch two independent Lines and verify both integrate with retained Car provenance. Test an invalid/stale proposal is refused as well. The earlier maintainer live test verified integration of the fixed demo, not this new Dispatcher model path.

## Automatic unloading and human approval

Each planned Line includes the Dispatcher's unloading recommendation and a short reason. Select **Auto-unload** or **Human approval** before launching; the persisted selection overrides the recommendation. You can also change a running Train's selection in its Line details until Terminus clearance is reserved.

Human approval affects only the final Terminus gate. Station execution, Conductor review, and Car attachment proceed normally. Once its Stations finish, the Train becomes `held` with an `awaiting_user_approval` reason and appears in the **Review yard**. Siding still means abandoned. Waiting for review never reserves integration clearance or prevents other eligible Trains from unloading.

Open the Train to review each accepted Car's diff, manifest, independent checks, and Conductor findings. In live mode, the existing preview button opens the Train's accepted application state. **Approve unloading** records permission for that exact Train commit; a changed Train requires fresh approval. This is approval of the Train, not a preview of its eventual merge with current Terminus. The integration Workflow still prepares a merge commit and independently validates it against current Terminus. Approval never overrides conflicts, failed checks, or other holds.

The fixed demo starts **Red Line** with auto-unload and **Blue Line** with human approval. For the competition demo, launch both, let Red unload while Blue waits in the review yard, refresh to demonstrate persistence, review Blue, then approve unloading. Offline mode follows the same lifecycle with simulated evidence; application preview requires live execution. Model recommendations and live Artifacts/Sandbox integration of this gate still need a maintainer live check.

```sh
# Change a saved proposal's selection before launch.
curl -X PUT http://localhost:8787/api/networks/NETWORK_ID/plans/PLAN_ID/lines/LINE_KEY/unload-mode \
  -H 'content-type: application/json' -d '{"mode":"human_approval"}'

# Change a running Train's policy before clearance.
curl -X PUT http://localhost:8787/api/trains/TRAIN_ID/unload-mode \
  -H 'content-type: application/json' -d '{"mode":"human_approval"}'

# Approve only the accepted commit shown in the reviewed snapshot.
curl -X POST http://localhost:8787/api/trains/TRAIN_ID/approve-unload \
  -H 'content-type: application/json' -d '{"trainCommit":"REVIEWED_TRAIN_COMMIT"}'
```

Migration `0008_unload_policy.sql` stores Dispatcher-owned permissions separately from Train state and closes approval/clearance races in D1. Existing Trains retain auto-unload. Local dev commands apply the migration; apply it remotely before deploying through the maintainer workflow.

## Execution and evidence

Departure forks the Station repository from the Train's current commit. The Station Sandbox clones it, runs `npm ci`, receives the D1 manifest as context, and executes its frozen harness configuration. After the process exits, orchestration commits remaining edits, runs configured validation, and collects actual exit codes, bounded stdout/stderr, changed paths and a binary Git patch. Agent summaries are only context.

Evidence is checkpointed in D1 before the candidate is pushed. A run becomes reusable only after its commit is confirmed in Artifacts. Retries can recover that candidate without another model call. If an unpushed candidate and its Sandbox have both disappeared, the run fails explicitly and requires a new run; it cannot silently attach a Car from incomplete evidence.

Station work receives one initial attempt and at most **three automatic revisions** by default. Failed required checks and Conductor returns share this allowance. If work is still rejected after the third revision, the deterministic Engineer blocks the Station and Train and raises an issue to the Dispatcher. The Dispatcher records `dispatcher.user_attention_requested` in the same atomic D1 batch and displays a persistent **User attention needed** alert above the planning panel. No further Station run starts automatically. The latest rejected candidate, repository reference, review feedback and independently collected evidence remain inspectable; earlier runs and reviews stay in history.

Configure the allowance with the `STATION_MAX_RETRIES` Worker var (default `3`, nonnegative integer; `0` disables automatic revisions). This bounds Station revisions, separately from Workflow retries of an interrupted infrastructure step. After intervention, **Retry Station after intervention** (or the existing Train clear endpoint) grants a fresh allowance and forks a new workspace from the Train's accepted state. The latest review feedback is passed to the new run, and the lifetime revision count and previous evidence are retained. Configuration changes require restarting the local Worker or redeploying through the maintainer workflow. No D1 migration is needed for this policy; older Station records use their existing revision count until explicitly restarted.

The Conductor receives the manifest, actual diff and independent validation. Missing or failed required checks return work without a model call. In live mode the Conductor uses its frozen harness configuration in its own Sandbox, reviewing a sealed checkout of the exact candidate commit, which already contains the Train's accepted Cars. Orchestration runs `npm ci` there before the model is reachable, then removes secret files, Git history and repository access. The Conductor reads the changed files and what depends on them, builds the project, runs checks, and starts the app in the background to exercise the changed behavior over HTTP before it decides. It has no editing tools and no write access to any repository. If it changes tracked files anyway, its review is discarded. Expect a review to take several minutes; the Train stays `reviewing` meanwhile. A review that fails, or still returns an invalid verdict after two corrections in the same session, blocks the Train and Station for intervention, as before. With fake repositories, the configured Conductor model reviews the supplied diff directly. Crossing handoffs, Junction input and feature acceptance, and Technician repairs are reviewed the same way, each against its own candidate: the merge candidate, the Junction head, or the repair workspace. Each review gets its own Workflow step, so expect those to take minutes too. Structured verdicts are validated and checkpointed in D1 before applying domain commands or moving repository heads, so acceptance retries preserve the original review. Acceptance performs a non-forced fast-forward from the reviewed Train commit, then attaches a Car retaining the accepted commit, diff, evidence, model configuration and review. A moved Train or incompatible history blocks acceptance rather than rewriting history.

Artifacts forks copy the current default branch, so the adapter verifies the requested commit before and after forking. Existing completed forks are reusable on retries; an unavailable historical snapshot fails explicitly.

The current runner supports npm projects and HTTPS/public imports. Dependencies must be retrievable from the npm registry without third-party install downloads. Private imports, arbitrary network access and deployment authentication are not implemented.

## Terminus integration

The deterministic Dispatcher clears the oldest eligible returning Train. Holds and unresolved conflicts keep the entry gate closed. D1 reserves one active integration attempt per network; the reservation has no expiry, so a slow or restarted Workflow cannot race another canonical writer. Every attempt has its own Integration Workflow and durable input, candidate, evidence and result. Only the Train Workflow changes the Train's state.

Each attempt forks a candidate repository from the current recorded Terminus commit, fetches the exact accepted Train head, and merges with `--no-ff`. The canonical commit is the first parent and the Train head is the second. The adapter verifies that the original Terminus baseline and every Car's accepted commit remain in history. It never rebases, squashes or force-merges. A Train already contained by Terminus needs no new merge; its current canonical state is still validated.

Project-wide validation runs in a fresh Sandbox checkout of the saved candidate, with read access to that repository and no model access or canonical write capability. Orchestration runs `npm ci` and every configured project command, collects actual exit codes and bounded output, and checks that validation did not change the candidate. Missing, failed or truncated evidence stops promotion. Passing evidence is checkpointed in D1 before a separate Git workspace obtains write access to Terminus.

Promotion pushes exactly the validated candidate using a non-forced fast-forward of the canonical ref, guarded against an unexpected remote head. The commit being pushed is a merge commit, preserving all accepted Car identities. D1 then records the new canonical head and completed attempt atomically and releases clearance. A second returning Train prepares against that new head. A lost push acknowledgement is recovered by checking the canonical Git head before attempting another write; a lost result event is recovered from D1 by the Train Workflow.

Conflicts become durable open conflict records, and the Train raises an issue to the Dispatcher. Failed integration validation also blocks the Train. After intervention, clear the blocked Train to start a new attempt; resolving a conflict record does not itself repair code, so unresolved Git conflicts will be detected again. A hold placed before promotion defers the attempt and holds the Train; releasing it resumes the Train automatically.

If Artifacts is unavailable while an uncertain promotion is being reconciled, clearance stays reserved and the Train receives an explicit integration blocker. The attempt retains its active status with an interruption result. Inspect the attempt and the Integration Workflow status, then use the retry endpoint once the Workflow is `errored`. Recovery clears the interruption, asks the blocked Train Workflow to resume, and restarts the same attempt with its D1 candidate and evidence intact. It reconciles the canonical head before another push. Do not manually delete active reservations.

The new `0003_integration.sql` migration and `INTEGRATION_WORKFLOW` binding are required. Local dev commands apply migrations automatically. For a deployed Worker, apply migrations and deploy the updated Worker through the maintainer workflow before testing a fresh demo network. New integration requires no additional model configuration or calls.

## API examples

Vite proxies `/api` to the Worker at port 8787. Create a network and import a project:

```sh
curl -X POST http://localhost:8787/api/networks \
  -H 'Content-Type: application/json' \
  -d '{"name":"Demo","sourceUrl":"https://github.com/OWNER/DEMO.git"}'
```

Omitting `sourceUrl` creates an initialized empty Artifacts repository in a new namespace. Push an npm baseline into that repository before starting real Station work.

Validation commands are trusted project configuration stored in D1, separate from model-generated manifests. Creation optionally accepts `validation`; defaults are `typecheck` (`npm run typecheck`), `test` (`npm test`), and `build` (`npm run build`). Every configured command is required. Each manifest's `expectedEvidence` must name configured commands; missing names prevent execution. Commands execute as argument arrays, not shell strings.

```sh
curl -X POST http://localhost:8787/api/networks/NETWORK_ID/demo
curl http://localhost:8787/api/networks/NETWORK_ID
curl 'http://localhost:8787/api/networks/NETWORK_ID/events?after=0'
curl http://localhost:8787/api/networks/NETWORK_ID/integrations
```

After repairing an integration issue:

```sh
curl -X POST http://localhost:8787/api/networks/NETWORK_ID/conflicts/CONFLICT_ID/resolve
curl -X POST http://localhost:8787/api/trains/TRAIN_ID/clear
```

To recover an errored attempt that still holds clearance:

```sh
curl -X POST http://localhost:8787/api/integrations/INTEGRATION_ID/retry
```

Architecture and ownership rules are in [AGENTS.md](./AGENTS.md), [the outline](./docs/outline-updated.md), and [technology architecture](./docs/technology-architecture.md).

## Technician repairs

When a Terminus merge fails with actual conflict paths, open the Dispatcher and choose **Dispatch Technician**. The Train stays blocked while a Technician works in a separate Artifacts repository. The harness can write only that repository and can read the affected Train; it receives no Terminus write capability or model credential. The Worker uses `TECHNICIAN_MODEL` through the existing outbound Gateway handler.

This first slice handles one Train's failed Terminus merge and limits repair edits to the recorded conflicted files. Clean automatic merge results must remain intact. Broader compatibility patches, Station recovery, and automatic repair revisions are not implemented. A rejection or execution failure requires an explicit fresh dispatch. A changed conflict set also stops the repair for intervention.

The Worker constructs a merge commit with the original Terminus and Train commits as its two parents, preserving accepted Car identities. It persists the candidate before running project-wide validation in a fresh, read-only Sandbox and submitting the actual full integration diff and reconciliation diff to the affected Conductor. The Dispatcher shows the checks, Conductor findings, diffs, and provenance. Choose **Approve repair and integrate** only after reviewing those results.

Approval records the exact source snapshots. A stale candidate cannot promote: dispatch a fresh Technician to reconcile against current Terminus. Unrelated conflicts and user holds still gate integration. The final integration process verifies the durable candidate again, reruns project-wide checks, and promotes exactly that reviewed commit. Only successful promotion resolves the linked conflict; the Train Workflow then unloads the Train. Rejected candidates, feedback, failed validation evidence, and source provenance remain inspectable.

Restart the updated Worker to load `TECHNICIAN_WORKFLOW` and `TECHNICIAN_MODEL`. Local dev applies `0007_technician.sql` automatically. Remote migration and deployment remain maintainer actions. No additional secret is required.

To exercise the flow offline, set `FAKE_INTEGRATION_CONFLICT_PATHS` in the `env.fake.vars` section of `apps/worker/wrangler.jsonc` to `src/App.tsx`, restart `npm run dev:fake`, and lay demo Lines in a new network. Every ordinary fake integration will report that scripted conflict; the fake Technician follows the same persisted review and explicit approval path. Set the value back to the empty string for ordinary fake integration. Fake diffs and checks are simulations and incur no model charges.

The HTTP commands are:

```text
POST /api/networks/:networkId/conflicts/:conflictId/technician
POST /api/networks/:networkId/repairs/:repairId/approve
```

Repair history is included in `GET /api/networks/:networkId` snapshots, and `technician.*` changes use the existing domain event feed. Execution continues with no browser connected; the approval command is the only user gate.

## Crossings

A Crossing lets a Line pick up accepted work at another Line's Station, then continue on its own route. The source Train keeps running. Pickup includes the source Train's complete accepted Car prefix at that Station, including previously imported work, but excludes later Stations. The receiving Train keeps its own Cars and copies only missing original Cars.

Run `npm run dev:fake` and `npm run dev:web`, create an empty Network, and select **Lay Crossing demo** in the Dispatcher. The Footer Line develops a component, accepts its tests (the checkpoint), and continues to a stylesheet Station. The Application Line builds a theme toggle, visits the Footer tests Station to pick up the first two Cars, then wires both components into App. Both Trains integrate into Terminus. Select the receiving Train to inspect Crossing attempts, candidate checks, compatibility review, and original Car links. The API/real-Workflow test verifies this flow without a browser.

Line creation accepts an optional `route` alongside the existing full Station definitions. For a Line defining `theme-toggle` and `app-wiring`, add this route:

```json
{
  "route": [
    { "kind": "station", "key": "theme-toggle" },
    { "kind": "crossing", "source": { "kind": "existing", "stationId": "footer-tests-station-id" } },
    { "kind": "station", "key": "app-wiring" }
  ]
}
```

Supply full Work Manifests in `stations` as in the existing Line API examples. Dispatcher proposals can instead use `{ "kind": "planned", "stationKey": "footer-tests" }` to reference a Station in the same proposal. Every owned Station must appear once. New Lines may reference existing Stations; running routes cannot be edited. The backend rejects reciprocal Line flow and dependency cycles.

`GET /api/crossings/:crossingId` returns the frozen checkpoint, attempt history, checks, reviews, and Car provenance. `POST /api/crossings/:crossingId/retry` explicitly retries a blocked pickup. A failed handoff never reopens the source Station. Persistent incompatibility requires replanning or `POST /api/trains/:trainId/siding` with a reason; Crossing Technician repair is outside v1. Uncertain Git writes retain their reservation and prevent abandonment until recovery.

For live verification, apply the new D1 migration locally, use the existing live Artifacts/Sandbox setup and configured extra-light models, and lay the same demo in a fresh Network. Verify that the receiver's checkpoint is the accepted Footer tests commit, that no stylesheet Car was copied, that the App Station workspace starts from the Crossing merge commit, and that both Trains unload through independently validated Terminus merges. Inspect failures and retries through the Crossing detail endpoint. This procedure does not require publishing or deploying Terminus.

## Junctions

Junctions let several Lines assemble one feature outside canonical Terminus. Inputs start at one frozen baseline and merge into a separate feature repository. Complete feature validation and Conductor review precede human release; release creates one outgoing Train that can run more Stations or go directly to Terminus. Several independent Junctions can run in one Network. Membership and routes remain fixed; nested Junctions and baseline refreshes are deferred.

Run the offline **Lay Junction demo** from a fresh Network's Dispatcher. It includes concurrent Footer/Theme work, independent main-Line work, human feature release, an outgoing App Station and final integration. [Junction architecture, API, recovery and verification](docs/junctions.md) documents the direct route, internal Crossing and Technician variants and the live Artifacts/Sandbox procedure. The additive `0012_junctions.sql` migration and `JUNCTION_WORKFLOW` binding are required. No deployment was performed by this implementation.
