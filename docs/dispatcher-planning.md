# Planning work with the Dispatcher

The Dispatcher turns a project goal into a persisted proposal of Lines and Stations that you review and explicitly launch.

## Proposing a plan

On a network page, expand **Dispatcher**, describe a project goal, and choose **Propose a plan**. The Dispatcher explores a read-only checkout of the exact saved Terminus commit using its configured harness in a Sandbox. With OpenCode it breaks the goal into focused questions and sends them to OpenCode's read-only `explore` subagents in parallel, then reads the files that decide each Station's boundaries. It cannot edit files, run shell commands, or reach the network. Secret files and Git history are removed before it starts, and repository-supplied OpenCode configuration and instruction files are disabled. Planning takes minutes rather than seconds; the proposal is saved when ready, so the panel can be closed.

Turn on **Check baseline first** in the composer to have orchestration install dependencies and run the project's configured checks on that commit before exploring. Results are trusted context for the Dispatcher and appear on the proposal. If a check fails and the goal doesn't already cover it, the Dispatcher suggests a separate **baseline fix** Line. It is included by default; **Reject fix** removes it. When included, every other Line picks up the accepted fix through a Crossing before its first Station. `PUT /api/networks/NETWORK_ID/plans/PLAN_ID/baseline-fix` with `{ "selection": "include" | "reject" }` makes the same choice.

## Following execution

While planning, the Dispatcher chat shows the real execution phase and a compact activity group. Related observations are grouped into **Workspace preparation**, **Project exploration**, **Proposal checks and corrections**, and **Finishing up**; offline planning has its own **Offline simulation** group. Labels summarize completed file reads, searches, listings, focused explorations and commands. Reported starts and failures are counted separately, because the feed has no invocation identities to correlate starts with completions. Counts describe retained observations, not unique files or whole-run totals. Failures remain visible above the groups even when details are collapsed; they do not by themselves mean the plan failed.

Expand a group for its observations, safe repository-relative paths and timestamps in execution order. **Earlier activity** opens the scrollable history while planning; **Execution activity** keeps it available after the proposal finishes or fails. A group's expansion choice survives new observations and its move into history. Tool observations contain only an allowlisted category, its reported status and, when safe, a repository-relative path. A completed read or exploration is an observation of tool execution, not proof that its conclusions are correct.

New group labels and observations arriving in open live details type out over 450 ms. Restored history, updated counts and tool failures appear immediately. The shared `TypedText` component accepts `durationMs` to tune the total reveal time (zero disables it), and `animate={false}` for immediate text. It respects reduced-motion preferences, exposes complete text to screen readers, and reserves the final text's space. Changed text appears immediately; a new component key starts a fresh reveal.

The shared harness path filters live events inside the Sandbox. Reasoning, assistant prose, search expressions, shell commands, tool arguments/results, task prompts and file contents are never published as activity. Raw harness events stay in the disposable Sandbox for the existing final-outcome parser. Native harnesses use the same normalized protocol; OpenCode reports focused exploration calls, while native command execution is described generically without command text. Child exploration internals are shown only when the harness actually emits them.

Activity is bounded to 200 recent observations from the current planning attempt, retaining its latest phase. D1 batches observations separately from canonical domain events; they cannot drive planning, Train movement or launch. Retries replace the activity attempt and reject late writes from an earlier one. Activity write failures do not fail planning. The browser polls only while the Dispatcher panel and page are visible, catches up after reopening and performs a final history fetch when planning finishes. Offline planning explicitly reports a simulation and never invents repository reads.

`GET /api/networks/:networkId/plans/:planId/activity?after=<seq>` returns `{ attempt, entries, lastSeq, hasMore }`, with at most 100 entries per page. Each entry contains `{ seq, at, activity }`; activity is either `{ kind: "phase", phase }` or `{ kind: "tool", tool, status, path? }`. Continue from `lastSeq` while `hasMore` is true. Replace local history when `attempt` changes. This endpoint checks that the plan belongs to the requested Network and returns `Cache-Control: no-store`.

Apply `0020_dispatch_activity.sql` before deploying this feature. Local Worker development applies it automatically. A live verification should confirm preparation phases appear before agent activity, tools appear before the harness exits, refresh restores history, and a retry replaces the old attempt. Live verification must use the maintainer-approved testing model.

## Reviewing a proposal

The proposal records **findings**: short facts from exploration with the paths that support them, shown under "What Dispatch explored". They contain no file contents. The backend validates the structured Lines and full Work Manifests and saves the proposal and assessment in D1. Review each Station's scope, expected/avoided areas, contracts, invariants, dependencies, acceptance criteria, and evidence. **Launch Lines** is a separate command; preparing or reopening a proposal does not start Station work. Plans contain at most eight Lines, six Stations per Line, and twenty-four Stations total, including a baseline fix. Model attempts are bounded and never switch models automatically.

With OpenCode, the Dispatcher submits its proposal through a `terminus_submit_proposal` tool while it works. The Sandbox's outbound handler serves the tool as a small remote MCP server inside the Worker (the request never leaves Cloudflare), checks the proposal with the same schema and assessment the Workflow uses, against the planning context orchestration granted that Sandbox, and replies with every problem so the session can fix them before it ends. Once a submission is accepted, the runner beside the harness stops OpenCode, so the session does not spend another model round trip on a closing message, and the accepted proposal becomes the answer. If a session ends otherwise, the last submitted proposal is the answer, unless a later final message carries JSON itself. Omissions that cannot change a plan are filled in before every check rather than sent back for resubmission: a `null` optional section (`junctions`, `findings`, `baselineFix`) counts as absent, and a missing Manifest `avoidAreas`, `contracts` or `dependencies` is empty. The check is advisory: the Workflow validates the proposal again. Other harnesses, or OpenCode when the tool cannot be reached, still reply with the proposal JSON. Manifests may carry `projectFacts`, the tooling facts the Dispatcher verified (test environment, setup files, installed libraries), so the Station and Conductor do not rediscover them.

The Dispatcher writes the whole proposal in one model response, and a large plan takes minutes to write: GLM runs at roughly 40–55 output tokens per second. A proposal cut off by the response's output limit is lost and written again from the start, so the Dispatcher's OpenCode agent gets a 16,384-token output limit (other roles keep 8,192), and its prompt sets a size budget of about 500 tokens per Station. To avoid repeating Line-wide values across a long Line, a proposed Line may carry an optional `shared` object with `avoidAreas`, `invariants`, `expectedEvidence` and `projectFacts`. Before validation, Terminus prepends these to each Station's Manifest on that Line, keeping a repeated value once, and then drops `shared`. Stored proposals and Station Manifests are therefore unchanged, and every Station still needs at least one invariant and one evidence name after the merge. `shared` is not offered on `baselineFix` or Junction Lines.

If the proposal still fails schema validation or domain assessment, the field locations and error codes, or the assessment problems, go back into the same native harness session for up to two corrections, so the Dispatcher keeps what it explored. Exhausted schema validation stops Workflow retries and saves safe diagnostics on the failed plan, without raw response values. A proposal that still fails assessment is saved and cannot launch. Transient failures retry the whole planning step once. `expectedAreas` and `avoidAreas` contain only plain paths; put explanations, CSS token restrictions, and other prose in scope or invariants instead. `avoidAreas` is a hard boundary for the Station and is usually empty: shared files a Station may need, such as a global stylesheet, go in `expectedAreas`, where overlaps become collision forecasts, with any limits stated in scope or invariants. Path patterns and this guidance are included in the model's JSON schema.

Every newly proposed Station must declare `repositoryChange: { kind, description }`, where `kind` is `implementation`, `tests`, `documentation`, or `configuration`, and the description names concrete repository edits. Running existing checks or confirming earlier features coexist belongs in acceptance criteria and expected evidence, rather than a separate Station. Adding or improving test files is valid work. Final merging and project-wide validation already belong to Terminus integration. Invalid declarations use the existing bounded proposal repair loop. Domain assessment refuses launch without a concrete deliverable, and the Engineer rechecks it before signaling; missing declarations on older waiting Stations block the Train and raise a persisted Dispatcher/user alert. Older plans remain inspectable but must be replanned before launch. A declaration is intent, not proof that the eventual diff will be nonempty; the Conductor still reviews independently collected changes.

## Dependencies and collision forecasts

Code-dependent work must stay on one Line. Dependencies can name only earlier Station keys on that Line; keys are unique across the proposal. Another Line completing a Station does not copy its code into this Train. Contract-based dependencies across planned or active Lines are rejected too. Expected areas use plain repository-relative paths/directories, without globs. Overlaps in declared files/directories or changing contracts are shown as collision forecasts, not stored as Git conflicts. Unknown evidence names or overlaps with avoided areas prevent launch. Forecasting is conservative declared intent; actual diffs, review, and integration checks remain authoritative.

## Launching

Launch requires the reviewed Terminus baseline still to be current. New collision forecasts also require a fresh proposal. Launch forks stable Train repository identities, then records all Lines, Stations, Trains, the plan, and events in one D1 batch guarded against stale canonical state. Only then does it start the individual Train Workflows. Retries reuse saved proposals and identities. Partial repository preparation can leave unused forks in Artifacts, but never a partially laid network. Closing or refreshing the browser does not stop planning or launch.

Each planned Line also carries an unloading recommendation; see [Automatic unloading and human approval](unloading.md).

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

## Removing Stations

Waiting or blocked Stations can be removed using **Remove Station** in their details, with a reason, or by posting `{ "reason": "Redundant verification" }` to `/api/networks/NETWORK_ID/stations/STATION_ID/remove`. The deterministic Dispatcher persists the request; the Train Workflow revalidates and applies it. Removal retains the Station as `cancelled` in topology and history, skips it in travel order, and never creates a Car or changes accepted commits. Removing the final Station returns the Train to the Terminus gate. Active/signaled work and accepted Stations cannot be removed. Removal is refused while any unfinished Station, including on another Line, depends on it; cancelled work never satisfies a dependency. Cancel dependents first or explicitly revise the plan. Review blockers belonging to discarded Station work can clear; unrelated conflicts stay blocked and user holds still apply. Lost command wakeups are recovered by periodic gate reads; a request that becomes invalid is recorded as `station.removal_refused` in activity.

Apply `0005_station_removal.sql` before deploying these changes. It protects dependency/removal checks against concurrent topology commands. Local Worker dev applies it automatically; remote migrations use the existing `wrangler d1 migrations apply terminus --remote` command from `apps/worker`.

## Offline planner

The offline environment clearly labels its planner as a simulation: it produces one generic Goal Line, uses fake repositories and checks, and makes no model calls. It exercises the same persisted proposal and launch path. The fixed two-Line demo remains available separately.

## Setup and live verification

For live development, restart the updated Worker so it loads `DISPATCHER_MODEL` and the `DISPATCH_WORKFLOW` binding. Local dev applies `0004_dispatch.sql` automatically. For deployment, apply this migration remotely and deploy the updated Worker through the maintainer workflow. The Dispatcher reuses the existing Gateway credentials and testing model; no additional secret is needed.

The first live check for this feature is a fresh goal on the demo baseline: inspect the generated manifests and forecasts, confirm no Trains exist before launch, refresh the page, then launch two independent Lines and verify both integrate with retained Car provenance. Test an invalid/stale proposal is refused as well. The earlier maintainer live test verified integration of the fixed demo, not this new Dispatcher model path.
