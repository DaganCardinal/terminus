# Terminus

Terminus coordinates coding agents on concurrent Lines of work. Each Train accumulates accepted Station work; D1 owns the railway state, Artifacts owns repositories, and Workflows coordinate execution. The browser polls snapshots and the domain event log.

The domain, persistence, API, Train/Station/Terminus integration Workflows, and React/SVG railway map are implemented. Real Artifacts and Sandbox/OpenCode adapters and a model Conductor are available alongside fakes. The maintainer verified both concurrent Trains reaching and integrating into Terminus in a live test. Returning Trains receive Dispatcher clearance, merge and validate against current Terminus, and unload after promotion. Focused model-driven Dispatcher planning is implemented: a goal becomes a persisted proposal that the user reviews and explicitly launches. This new planning path still needs live verification. Technician reconciliation of failed Terminus merges is implemented with durable candidates, independent validation, Conductor review, and explicit approval; it still needs live Artifacts/Sandbox verification. Model-assisted Engineer decisions remain future work.

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

Open the URL Vite prints. Create a network and choose **Lay demo Lines**. The two Trains run independently; the Red Line has two ordered Stations, and the Blue Line has one. Fake reviews request one revision by default. Accepted work appears as Cars with events in the status page. Returning Trains integrate one at a time and finish at `unloaded`.

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

If local Wrangler 4.147.0 prints repeated `internal error; reference = ...` messages, enable `WRANGLER_LOG=debug` and check the stack. A known local failure points to Miniflare's `observability/collector.worker.js` with `Cannot perform I/O on behalf of a different request` and `I/O type: OutgoingFactory`. Restart with the local collector disabled:

```sh
X_LOCAL_OBSERVABILITY=false WRANGLER_LOG=debug npm run dev:worker
```

This workaround uses Wrangler's local development switch; terminal command/model diagnostics and deployed Worker observability remain available. An HTTP 200 from the model only confirms response headers arrived. Station completion still requires OpenCode to exit, independent validation, publication, and Conductor review.

Local `.dev.vars` entries have this shape:

```dotenv
AI_GATEWAY_ACCOUNT_ID=YOUR_32_HEX_ACCOUNT_ID
AI_GATEWAY_ID=default
AI_GATEWAY_TOKEN=YOUR_ACCOUNT_SCOPED_WORKERS_AI_TOKEN
```

`STATION_AGENT_MODEL`, `CONDUCTOR_MODEL`, `DISPATCHER_MODEL`, and `TECHNICIAN_MODEL` are configured as **`@cf/zai-org/glm-5.3-flash`** for testing. OpenCode's primary and small-model settings use that same configured identity. The calls use low reasoning effort for testing. There is no automatic fallback to the expensive production models mentioned in the design documents.

The Sandbox image pins OpenCode 1.18.32 and Node 24. OpenCode's internal snapshots are disabled: their Git subprocesses reproduced a harness hang in local Sandboxes. Terminus captures candidate commits, diffs, and validation evidence independently after the harness exits. The required Sandbox Durable Object is only a container adapter; it stores no orchestration state. Outbound access is limited to its explicitly granted repository, the configured model endpoint, and the npm registry. Repository tokens are short-lived and repo-scoped, and the Worker injects them into Git requests. The Station process receives neither repository tokens nor model secrets. Orchestration uses separate workspaces for writes to a Train.

For a deployed Worker, create/bind the D1 database, configure its `database_id`, apply migrations remotely, set the secret, and deploy from `apps/worker`:

```sh
npx wrangler d1 create terminus
# Copy the returned database_id into wrangler.jsonc before continuing.
npx wrangler d1 migrations apply terminus --remote
npx wrangler secret put AI_GATEWAY_TOKEN
npm run deploy
```

Deployment is a maintainer action. The frontend currently runs separately through Vite; this Worker deployment does not publish the React app. The API currently has no authentication, so use a controlled development environment.

## Previewing a Train

Select a Train on the map and choose **Preview Train** in its drawer. A new browser tab opens while Terminus prepares a separate Cloudflare Sandbox. The preview checks out the Train's exact saved `headCommit`, runs `npm ci` and `npm run build`, and serves the demo app with Vite preview on port 8080. It shows accepted Cars; work still in a Station workspace appears only after Conductor acceptance. The runner is currently hard-coded for the Vite-based `terminus-demo-app`.

Previews have read-only access to that Train repository while cloning, no model access, and no ability to push. Repository access is removed and its token revoked after preparation. Previewing does not change Train state or start its Workflow. Reopening the same accepted snapshot reuses a running Sandbox; a newer accepted commit gets a separate preview. A Sandbox stops after five minutes without requests. Open **Preview Train** again to rebuild an expired preview.

Local development uses `http://preview-<snapshot>-<token>.localhost:8787/`, routed directly to Wrangler. Docker and the real Worker (`npm run dev:worker`) must be running. The fake environment reports that it has no real app to preview. If Wrangler runs on another port, set `PREVIEW_BASE_URL=http://localhost:PORT` in `.dev.vars`.

Deployment requires a separate preview domain with wildcard DNS, TLS, and a Worker route. Set `PREVIEW_BASE_URL` to its HTTPS origin, for example `https://example-previews.com`, and route `*.example-previews.com/*` to this Worker. Keep `workers_dev: true` if adding routes should preserve the existing API URL. No domain or route is provisioned by this change. See Cloudflare's [preview hostname setup](https://developers.cloudflare.com/sandbox/previews/serve-previews-on-their-own-hostnames/) for DNS and certificate details. Each preview has its own browser origin, and requests to its hostname reach only the preview app, including paths beginning with `/api`. Anyone with the preview URL can view it while its Sandbox is running; keep it private if the changes are private.

The API action is `POST /api/trains/TRAIN_ID/preview`. Its response contains `trainId`, the exact preview `commit`, and `url`. Installation/build/startup failures return an error and dispose of the failed Sandbox; they do not block or mutate the Train.

## Planning work with the Dispatcher

On a network page, expand **Dispatcher**, describe a project goal, and choose **Propose a plan**. Planning reads the exact saved Terminus commit with repository-scoped read access. It supplies a bounded file inventory (500 paths) and up to twelve source/documentation excerpts (4,000 characters each), with explicit truncation flags, plus active Line manifests and trusted validation names. It never installs or executes project code while gathering context. Source contents are transient model context, not project files stored in D1.

The configured Dispatcher model returns structured Lines and full Work Manifests. The backend validates the output and saves the proposal and assessment in D1. Review each Station's scope, expected/avoided areas, contracts, invariants, dependencies, acceptance criteria, and evidence. **Launch Lines** is a separate command; preparing or reopening a proposal does not start Station work. Plans contain at most four Lines, six Stations per Line, and twelve Stations total. Model attempts are bounded and never switch models automatically.

If output fails schema validation, the Dispatcher supplies the previous proposal and safe field locations/error codes to the same model for up to two corrective attempts. Exhausted output validation stops Workflow retries and saves these diagnostics on the failed plan, without raw response values. Transient transport or persistence failures still use Workflow retries. `expectedAreas` and `avoidAreas` contain only plain paths; put explanations, CSS token restrictions, and other prose in scope or invariants instead. Path patterns and this guidance are included in the model's JSON schema.

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

## Execution and evidence

Departure forks the Station repository from the Train's current commit. The Station Sandbox clones it, runs `npm ci`, receives the D1 manifest as context, and executes OpenCode. After the process exits, orchestration commits remaining edits, runs configured validation, and collects actual exit codes, bounded stdout/stderr, changed paths and a binary Git patch. Agent summaries are only context.

Evidence is checkpointed in D1 before the candidate is pushed. A run becomes reusable only after its commit is confirmed in Artifacts. Retries can recover that candidate without another model call. If an unpushed candidate and its Sandbox have both disappeared, the run fails explicitly and requires a new run; it cannot silently attach a Car from incomplete evidence.

Station work receives one initial attempt and at most **three automatic revisions** by default. Failed required checks and Conductor returns share this allowance. If work is still rejected after the third revision, the deterministic Engineer blocks the Station and Train and raises an issue to the Dispatcher. The Dispatcher records `dispatcher.user_attention_requested` in the same atomic D1 batch and displays a persistent **User attention needed** alert above the planning panel. No further Station run starts automatically. The latest rejected candidate, repository reference, review feedback and independently collected evidence remain inspectable; earlier runs and reviews stay in history.

Configure the allowance with the `STATION_MAX_RETRIES` Worker var (default `3`, nonnegative integer; `0` disables automatic revisions). This bounds Station revisions, separately from Workflow retries of an interrupted infrastructure step. After intervention, **Retry Station after intervention** (or the existing Train clear endpoint) grants a fresh allowance and forks a new workspace from the Train's accepted state. The latest review feedback is passed to the new run, and the lifetime revision count and previous evidence are retained. Configuration changes require restarting the local Worker or redeploying through the maintainer workflow. No D1 migration is needed for this policy; older Station records use their existing revision count until explicitly restarted.

The Conductor receives the manifest, actual diff and independent validation. Missing or failed required checks return work without a model call. Structured verdicts are validated and checkpointed in D1 before applying domain commands or moving repository heads, so acceptance retries preserve the original review. Acceptance performs a non-forced fast-forward from the reviewed Train commit, then attaches a Car retaining the accepted commit, diff, evidence, model configuration and review. A moved Train or incompatible history blocks acceptance rather than rewriting history.

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

Omitting `sourceUrl` creates an initialized empty Artifacts repository. Push an npm baseline into that repository before starting real Station work.

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
