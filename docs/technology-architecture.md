# Technology Architecture and Ownership

This document defines the primary technologies used by the application, what each technology is responsible for, and — equally importantly — what it is **not** responsible for.

The core architectural rule is:

> **Artifacts own code and version history. The application domain owns workflow meaning. Cloudflare infrastructure executes the workflow. The UI presents it.**

No individual infrastructure component should become the place where all application logic accumulates.

---

# Technology Stack

| Layer             | Technology                 | Primary Responsibility                                                     |
| ----------------- | -------------------------- | -------------------------------------------------------------------------- |
| Language          | TypeScript                 | Shared language across frontend, backend, domain, agents, and integrations |
| Frontend          | React + Vite               | Application UI                                                             |
| UI Components     | shadcn/ui                  | Standard interface components                                              |
| Visualization     | React-based 2D network/map | Trains, stations, lines, movement and status                               |
| API / Backend     | Cloudflare Workers         | Application API and infrastructure coordination                            |
| Domain            | Pure TypeScript packages   | Business rules, entities and state transitions                             |
| Durable Processes | Cloudflare Workflows       | Long-running/retryable execution                                           |
| Application Data  | Cloudflare D1              | Queryable application metadata and workflow state                          |
| Code / Git State  | Cloudflare Artifacts       | Versioned repositories and project state                                   |
| Code Execution    | Cloudflare Sandboxes       | Isolated environments for coding agents, builds and tests                  |
| AI                | Workers AI + AI Gateway    | Model execution and model routing                                          |
| Deployment        | Cloudflare Workers         | Hosting the web application and backend                                    |

---

# 1. TypeScript Monorepo

The project should be structured as a TypeScript monorepo rather than a collection of scripts.

A rough organizational model is:

```text
/
├── apps/
│   ├── web/
│   │   └── React application
│   │
│   └── worker/
│       └── Cloudflare Worker/API
│
├── packages/
│   ├── domain/
│   │   └── Core application model and state machines
│   │
│   ├── protocol/
│   │   └── Commands, events, API contracts and schemas
│   │
│   ├── agent-runtime/
│   │   └── Dispatcher, Station Agent, Conductor and Technician runtimes
│   │
│   ├── artifacts/
│   │   └── Cloudflare Artifacts/Git integration
│   │
│   └── ui/
│       └── Shared React components
│
└── ...
```

The exact directory structure may evolve, but the **boundaries should not**.

Avoid creating miscellaneous directories such as:

```text
/scripts/
```

containing unrelated application logic.

Logic belongs to the package that owns the concept.

---

# 2. Domain Layer

The domain layer is the **source of truth for what the application means**.

It should be written as ordinary TypeScript with minimal Cloudflare-specific dependencies.

It defines concepts such as:

- Network
- Line
- Train
- Station
- Car
- Station Manifest
- Terminus
- Agent assignment
- Acceptance/rejection
- Holds
- Conflicts
- Train movement
- Station activation

It also defines legal state transitions.

For example:

```text
train.departed            Train: in_transit    Station: signaled
    ↓
station.started                                Station: active
    ↓
station.ready_for_pickup  Train: approaching   Station: ready_for_pickup
    ↓
train.arrived             Train: docked
    ↓
review.started            Train: reviewing     Station: in_review
    ↓
car.attached              Train: ready         Station: complete
```

The full state lists and event vocabulary are defined in `outline-updated.md`.

The domain decides whether a transition is valid.

Cloudflare Workflows may **execute** that transition.

D1 may **store** that transition.

React may **display** that transition.

But none of those layers should invent it.

## Ownership

**Domain owns:**

- business rules
- lifecycle definitions
- entity relationships
- allowed transitions
- invariants
- acceptance rules
- dependency rules

**Domain does not own:**

- database queries
- React rendering
- AI provider calls
- Git commands
- Cloudflare API calls

---

# 3. React + shadcn/ui

The primary interface is a React application built with Vite.

Use **shadcn/ui** for conventional application interface elements such as:

- dialogs
- buttons
- dropdowns
- command palettes
- sidebars
- tabs
- forms
- sheets
- tooltips
- status panels

The central visualization is a **2D network/map**, not a 3D Three.js environment.

The renderer should visualize domain state such as:

```text
Train A
currentSegment: station-2 → station-3
status: in_transit

Station 3
status: active
progress: ...
```

The UI can animate the train travelling between those locations, but that animation is **presentation only**.

A train does not arrive because a CSS animation finished.

The backend/domain says:

```text
train.arrived
```

and the UI represents that event visually.

## How the UI receives state

The UI **polls** the Worker API. There are no WebSockets.

- On load, the UI fetches a network snapshot that includes the latest event sequence number.
- It then polls `GET /networks/:id/events?after=<seq>` every 1–2 seconds and applies new events in order. It can poll faster while Trains are moving and slower while the network is idle.
- Every state change writes its domain event to an ordered event log in D1, in the **same D1 batch** as the state change. The event log can therefore never disagree with the state.
- That same event log feeds the activity feed and the audit trail.

Train movement shows work of unknown length, so a 1–2 second delay isn't noticeable. Polling also adds no second store that could become a rival source of truth, and it makes a browser refresh harmless.

If push delivery is needed later (for example, to stream live agent output), a thin Durable Object can broadcast the *same* events. The UI's event handling stays the same. Don't introduce that without approval.

## UI ownership

**React owns:**

- rendering
- interaction
- local UI state
- animation
- network visualization
- forms
- command submission
- displaying logs/status/results

**React does not own:**

- orchestration
- Git state
- agent execution
- lifecycle transitions
- canonical workflow state
- determining whether work has been accepted

Refreshing the browser must never alter the actual workflow.

---

# 4. Cloudflare Workers

Cloudflare Workers are the application's backend entry point.

The Worker sits between the UI and the rest of the Cloudflare infrastructure.

Typical responsibilities include:

```text
React
   ↓
Worker API
   ├── Domain
   ├── D1
   ├── Workflows
   ├── Workers AI / AI Gateway
   ├── Artifacts
   └── Sandboxes
```

Workers should expose application-level commands such as:

```text
createProject()
createLine()
dispatchTrain()
approveConflictResolution()
pauseTrain()
resumeTrain()
```

rather than exposing infrastructure primitives directly to the browser.

For example, the frontend should not say:

```text
createArtifactsRepo()
```

It should say something like:

```text
createLine()
```

and the backend determines which infrastructure operations that requires.

## Worker ownership

**Workers own:**

- HTTP/API boundary
- authentication/authorization
- command handling
- infrastructure adapters
- starting Workflows
- starting agent operations
- Artifacts integration
- D1 access
- model access
- Sandbox access

**Workers do not own:**

- the definition of Train/Station lifecycle rules
- frontend presentation

---

# 5. Cloudflare Artifacts

Cloudflare Artifacts is the **versioned filesystem and Git layer of the application**.

Artifacts should be thought of as the physical implementation of the project's evolving code state.

It is not our workflow database.

It is not our UI state store.

It is not merely somewhere to dump files.

Artifacts provides isolated, Git-compatible repositories that can be created and forked programmatically.

That makes it fundamental to the Train metaphor.

---

## Terminus

The Terminus represents the canonical integrated project state.

Conceptually:

```text
Terminus
└── canonical Artifacts repository
```

Only the final integration process should modify this state.

Station Agents never write directly to Terminus.

## Onboarding a Project

Artifacts is the home of every project Terminus manages. That is the core of the platform, not an implementation detail.

A new project's Terminus repository is created in one of two ways:

- **Import** from a public Git URL, using the binding's `import()`.
- **Create** an empty repository with `create()`, then push the first commit using the returned remote URL and token.

To get code out, use a standard `git clone` of the Terminus repository with a read-scoped token. Terminus does not sync integrated results to GitHub or any other host. Importing private repositories, which would need source-host credentials, is out of scope for now.

---

# 6. Train Repositories

Each active Train receives an isolated Artifacts repository derived from the relevant Terminus state.

```text
Terminus
    │
    └── fork
         ↓
      Train A
```

The Train repository represents:

> **Everything this Train has accepted so far.**

As Stations are completed and accepted, their work is incorporated into the Train.

Therefore the Train continuously evolves.

```text
Train departs
    ↓
baseline

Station A accepted
    ↓
baseline + Car A

Station B accepted
    ↓
baseline + Car A + Car B

Station C accepted
    ↓
baseline + Car A + Car B + Car C
```

This evolving snapshot is extremely important.

A Train is not merely a list of disconnected patches.

It carries a real, working integration state.

## Incorporating Accepted Work

The Artifacts Workers binding can create, fork, read, and issue tokens. It has **no server-side merge**. Accepted Station work is therefore applied to the Train over the Git protocol, by orchestration code rather than by the Station Agent. That code runs either in a Sandbox owned by the orchestration layer (holding a write token for the Train) or with a JavaScript Git client in the Worker. This choice stays inside `packages/artifacts`.

Within a Line, incorporation is always a **fast-forward**. A Station is forked from the Train's latest commit, and the Train changes only by attaching that Line's own Cars, so the Station's commits sit directly on top of the Train.

If the Train's latest commit has moved since the Station was forked (for example, because of a Technician patch), the work is not fast-forwardable. It must not be force-merged. It goes back through review against the new Train state.

## Integrating a Train into Terminus

Terminus integration and configured Crossing pickups are the explicit merge boundaries. A Crossing merges an accepted source Station checkpoint into a stopped receiving Train without rerunning the Station. Terminus may have moved since the Train was created. The Terminus integration Workflow performs the merge in a Sandbox owned by the orchestration layer.

**Use merge commits. Never rebase or squash.** Each Car references its accepted commit, and rebasing or squashing would rewrite those commit IDs and break every Car's provenance. If there are conflicts, the merge is not forced. The Train raises an issue, and the Dispatcher may dispatch a Technician.

---

# 7. Station Repositories

When a Station becomes active, it receives an isolated workspace derived from the **current Train state**.

```text
Train A
   │
   └── fork
        ↓
     Station A3
```

The Station Agent works only inside this isolated state.

It may:

- inspect the project
- edit files
- run commands
- install dependencies
- run tests
- build the project
- commit changes

It cannot directly modify:

- the Train
- another Station
- Terminus

When it finishes, the result becomes a candidate for review.

```text
Station Repo
      ↓
   Conductor
      ↓
 accept / reject
```

Only accepted Station work moves onto the Train.

---

# 8. Cars

A Car represents an **accepted unit of work** attached to a Train.

Cars are primarily a domain concept.

A Car does **not necessarily need its own Artifacts repository**.

Instead, it references the accepted Git state associated with the Station change.

For example:

```text
Car
├── stationId
├── manifestId
├── acceptedCommit
├── acceptedAt
├── conductorReview
├── testEvidence
└── changedSurfaces
```

The Train repository remains the actual integrated filesystem.

The Car provides the semantic history explaining **why that change exists**.

---

# 9. Technician Workspaces

Conflict resolution should also happen in isolated Artifacts state.

If two Trains conflict:

```text
Train A ──┐
          ├── Technician Workspace
Train B ──┘
```

The Technician receives the relevant context and creates a reconciliation candidate.

The Technician does not silently rewrite either Train or Terminus.

Its work must still pass the appropriate validation/integration process.

---

# 10. Station Manifests

Every Station has a structured work manifest.

Example conceptually:

```yaml
goal: Add authentication middleware

scope:
  - API routes
  - auth package

dependencies:
  - user schema

interfaces:
  - POST /login
  - Session interface

invariants:
  - existing API routes must remain compatible

acceptance:
  - tests pass
  - unauthenticated requests return 401
```

The manifest is part of **application/domain state**.

D1 stores the authoritative structured metadata.

A snapshot may also be placed into the Station workspace so the coding agent has the instructions locally.

That copy is agent context.

It is **not a second source of truth**.

---

# 11. Cloudflare D1

D1 stores queryable application state.

Think:

> **What does the platform know about the network?**

rather than:

> **What files currently exist in the project?**

D1 may contain records for:

- Projects
- Networks
- Lines
- Trains
- Stations
- Cars
- Manifests
- Agent runs
- Dependencies
- Status
- Holds
- Conflict records
- Artifact repository IDs
- commit references
- Workflow IDs
- timestamps
- user decisions

For example:

```text
station
├── id
├── line_id
├── train_id
├── status
├── manifest_id
├── artifact_repo_id
├── base_commit
├── result_commit
└── workflow_id
```

## D1 does not store

D1 should not contain:

- entire source trees
- Git history
- generated repository files
- duplicated source code

That belongs in Artifacts.

---

# 12. Cloudflare Workflows

Cloudflare Workflows owns **durable execution**.

Many operations in this application may take minutes or considerably longer:

```text
activate Station
    ↓
start agent
    ↓
agent works
    ↓
run tests
    ↓
wait for Train arrival
    ↓
Conductor reviews
    ↓
accept/reject
    ↓
update Train
```

This should not be represented by one giant Worker request.

Workflows coordinate these long-running processes and provide:

- durable steps
- retries
- waiting
- recovery
- external-event handling
- long-running execution

A Workflow may coordinate a lifecycle, but it does not define what that lifecycle means.

That still belongs to the domain.

## Workflow Layout

| Workflow | Instances | Responsibility |
| --- | --- | --- |
| **Train** | One per Train | Runs the Train's entire lifecycle, from the depot to `unloaded` or `siding`. It evaluates Engineer gates, signals Stations, waits for Station work, runs Conductor review, and attaches Cars. It is the **only writer** of that Train's state. |
| **Station** | One per Station run | Forks the workspace, runs the coding agent in a Sandbox, pushes the result, and marks the Station `ready_for_pickup`. Evidence is collected during Conductor review. |
| **Terminus integration** | One per integration attempt | Merges a returning Train into Terminus and runs project-wide validation. |

Other actors never write a Train's state directly. The Dispatcher, the user, and Station Workflows send events to that Train's Workflow instance, and the Train Workflow waits for them. This is how "each Train owns its own state" works without custom Durable Objects.

## Important distinction

```text
Domain:
"After Station work is ready and the Train arrives,
the next legal state is Conductor review."

Workflow:
"Run these operations reliably until we reach that state."
```

---

# 13. Cloudflare Sandboxes

Coding agents require an actual development environment.

Cloudflare Sandboxes provide isolated Linux execution environments where an agent can:

- clone its Station repository
- inspect files
- edit files
- install packages
- run builds
- run tests
- execute scripts
- use Git
- produce commits

A Sandbox is therefore an **execution environment**, not persistent project storage.

Conceptually:

```text
Artifacts
   ↓ clone
Sandbox
   ↓
Agent works
   ↓ commit/push
Artifacts
```

If the Sandbox disappears, no accepted project history should disappear with it.

Anything durable must already have been committed back to Artifacts or recorded in application state.

## Coding Agent Harness

A model on its own only produces text and tool requests. A **harness** runs the loop that turns those requests into actions: it sends the task to the model, carries out the requested reads, edits, and commands in the Sandbox, returns the results, and repeats until the model is done.

Station Agents, Technicians, the Dispatcher's planning session, and every Conductor review use an existing harness running **inside** the Sandbox. The default is **OpenCode**:

- It is open source and works with any model provider.
- It has a built-in `cloudflare-ai-gateway` provider.
- Cloudflare documents how to run it in a Sandbox.

The harness sits behind a runner interface in `packages/agent-runtime`, and supports per-role OpenCode, Claude Code and Codex adapters behind a release gate. Settings and immutable execution snapshots are described in [Harness selection](harness-selection.md). Workflows keep their cached step shapes; new work includes frozen provider/model/harness/version configuration.

A Station run works like this:

```text
Station Workflow
  ↓ fork Station repo from Train (Artifacts)
  ↓ create a short-lived, write-scoped token for the Station repo only
  ↓ start Sandbox, clone the Station repo, write the manifest into the workspace
  ↓ install dependencies, then prepare the harness (config, preflight, root guidance)
  ↓ invoke the frozen harness adapter with the Station capability profile
  ↓ wait for the process to exit (exit code + JSON event log)
  ↓ push to the Station repo, read the resulting commit
  ↓ Station → ready_for_pickup
  ↓ (Train review step) a fresh Conductor Sandbox installs the candidate and
    orchestration runs the required validation there, before any model starts
```

- **Completion is detected when the harness process exits and the adapter validates its final outcome.** Do not rely on Artifacts push notifications for this. Push notifications require a separate subscription for every repository and are delivered to a Queue, which does not suit Station repositories created on the fly.
- **Evidence comes from our own validation run**, not from the agent's own summary. It runs in the Conductor's clean checkout, never in the Sandbox where the Station Agent had a shell.
- **Repository content is untrusted for every harness role.** One shared preparation step (`prepareHarness`) gives each role its trusted system prompt and capability profile through the configured adapter. It disables repository OpenCode configuration and instruction files, and removes user-level configuration that repository code could have written. It then attaches the root `AGENTS.md` (or `CLAUDE.md`) to the first message as delimited data. Every role, including the sandboxed Conductor, uses this step, and the Dispatcher and Conductor share one session runner (`HarnessSession`).
- The curated catalog resolves the provider-native model ID, compatible harnesses, pinned version and explicit cost order. OpenCode supports Workers AI, Anthropic Messages and OpenAI Responses; Claude Code supports Anthropic Messages; Codex supports OpenAI Responses. Native provider requests pass through AI Gateway with Worker-injected authentication. Provider keys stay in Cloudflare’s dashboard. No runtime model or billing fallback is implemented.

Engineer models do **not** use a harness. They are called directly through the `ModelProvider` and return structured output.

The Dispatcher plans in a **read-only** harness session:

```text
Dispatch Workflow "prepare proposal"
  ↓ read-only token for Terminus; Sandbox allows Git reads, no model
  ↓ detached checkout of the exact Terminus commit
  ↓ [optional] npm ci + configured checks → trusted baseline report
  ↓ remove secret files and .git; drop repository access; allow only the model
  ↓ opencode run --agent dispatcher (edit, bash, web denied; Task → explore only)
  ↓ validate the final message; correct in the same session (--session, ≤2 times)
  ↓ proposal (+ findings, baseline report) → D1 → user review → explicit launch
```

As for every harness role, repository-supplied OpenCode configuration and instruction files are disabled, so project content stays untrusted data and cannot change the Dispatcher's prompt or permissions; the root `AGENTS.md` is supplied in its first message as delimited data instead. Raw harness events, which include file contents the agent read, stay in the Sandbox; only the session id, final message, and tool-use counts leave it.

The Conductor reviews every candidate in a **verification** harness session: Station work, Crossing handoffs, Junction inputs and features, and Technician repairs. The steps below show a Station review; the others differ only in the repository and commit checked out (the integration merge candidate, the Junction head, or the repair workspace), the review files (repairs add the Technician's own `repair.diff`), the review-kind guidance appended to the prompt, and the Workflow step that runs them. Unlike the Dispatcher, it may run commands, so it can build the candidate and run the app end to end:

```text
Train Workflow "review <station>" (own step: 30 minutes, one retry)
  ↓ read-only token for the Station repo; Sandbox allows Git reads, no model
  ↓ detached checkout of the exact candidate commit; npm ci
  ↓ write patch, check output and review input to /workspace/review
  ↓ fingerprint tracked files; remove secret files and .git; drop repository access; allow only the model
  ↓ opencode run --agent conductor (bash allowed; edit, web, skills denied;
  ↓   external directories limited to /workspace/review and /tmp; Task → explore only)
  ↓ discard the review if tracked files changed; correct the verdict in the same session (≤2 times)
  ↓ verdict → conductor_reviews (D1)
Train Workflow "advance" applies the recorded verdict: accept → fast-forward + Car, return, or escalate
```

| Review | Candidate checked out | Runs in | Applied by |
| --- | --- | --- | --- |
| Station | Station repo at the proposal head | Train Workflow `review` step (30 min) | next Train `advance` |
| Crossing, Junction input | integration merge candidate | Integration Workflow `Conductor review` step (30 min) | `promote candidate` |
| Junction feature | Junction repo at its head | Junction Workflow `review Junction feature` step (45 min, includes feature validation) | the same step (`ready` or `blocked`) |
| Technician repair | repair workspace at its candidate | Technician Workflow `Conductor reconciliation review` (30 min) | the same step |

Each step gets one retry. A session is paid and takes minutes, so retrying it as freely as a D1 write would multiply cost.

Nothing the Conductor does is kept: its Sandbox has no repository write access and is destroyed after the review. The fingerprint check guards the verdict, not the repository: a review that changed tracked files (formatting, fixes, updated snapshots, dependency changes) would describe something other than the candidate, so it fails and the Train blocks with `review_escalated`.

## Security boundary

Each Station Agent should receive only the credentials and repository access required for its job.

A Station Sandbox should not receive credentials capable of modifying Terminus or the Train.

- Repository access is a short-lived Artifacts token scoped to the Station repository only.
- Model credentials never enter the Sandbox. The harness is given a placeholder key, and the Worker's outbound handler replaces it with the real AI Gateway token on each request.
- Outbound network access from the Sandbox is limited to what the job needs (AI Gateway, Artifacts, and package registries).

---

# 14. Workers AI + AI Gateway

AI models should sit behind a common application-level abstraction such as:

```ts
interface ModelProvider {
  generate(...)
  generateStructured(...)
  useTools(...)
}
```

The rest of the application should ask for a role or capability rather than hardcoding model IDs throughout the codebase.

For example:

```text
Dispatcher
    ↓
ModelProvider
    ↓
GLM-5.3
```

or:

```text
Station Agent
    ↓
ModelProvider
    ↓
Kimi K2.7 Code
```

For current implementation and testing, the maintainer has selected **`@cf/zai-org/glm-5.3-flash` for every real agent call**. The Worker role vars and OpenCode primary/small-model configuration use that model, with no automatic fallback. The table below describes future production choices, not testing configuration. See [Station execution](station-execution.md) and [Live setup](live-setup.md) for the implemented execution path and setup.

Expected production defaults are approximately:

| Role                                         | Default Model                                  |
| -------------------------------------------- | ---------------------------------------------- |
| Dispatcher                                   | GLM-5.3                                        |
| Station Agent                                | Kimi K2.7 Code                                 |
| Conductor                                    | GLM-5.3 or another strong independent reviewer |
| Technician                                   | GLM-5.3                                        |
| Engineer / lightweight operational decisions | Clef or Clef-flash (`@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash`) |

Model selection should remain configuration. Users will be able to configure models per role in the future.

The identity of a Station Agent should not depend on Kimi specifically.

Where practical, the Conductor should use a different model family from the Station Agent.

This allows models to change later without changing the architecture.

AI Gateway should provide the common routing/observability layer when appropriate, including the ability to use Cloudflare-hosted Workers AI models or external providers.

---

# 15. Agent Ownership

The infrastructure and the conceptual agent roles should remain separate.

## Dispatcher

Owns:

- decomposition
- Line planning
- Station planning
- dependency analysis
- scheduling
- assigning work
- concurrency decisions
- collision detection
- escalation

Does not implement project code.

---

## Station Agent

Owns:

- implementing one Station Manifest
- editing its isolated workspace
- running tests
- producing implementation evidence
- committing proposed work

Cannot accept its own work.

Cannot modify the Train directly.

---

## Conductor

Owns:

- independent review
- checking the Station Manifest
- reviewing the actual diff
- inspecting test/build evidence
- verifying the candidate in its own Sandbox: building it and running the app end to end
- accepting or rejecting work

Acceptance updates the Train and creates a Car.

---

## Technician

Owns exceptional integration work such as:

- merge conflicts
- incompatible Train changes
- failed reconciliation
- complex repair work

Technician changes should also be isolated and reviewed rather than receiving unrestricted canonical write access.

---

# 16. Engineer / Deterministic Control Layer

Not every decision should be made by an LLM.

Mechanical rules should remain deterministic.

Examples:

```text
Tests failed → do not accept
Merge conflict exists → do not integrate
Dependency incomplete → do not activate dependent Station
User hold exists → do not proceed
Conductor rejected work → return to Station
```

AI can interpret ambiguous situations and recommend actions.

It should not replace deterministic safety gates.

This layer effectively controls the railway signals.

## Clef for Ambiguous Decisions

For choices the hard rules don't settle, the Engineer uses a **decision model**, by default Clef (Workers AI). Clef doesn't generate text. It takes a state and a set of typed questions with fixed answer options, and returns a probability for each option.

That suits the Engineer well:

- The answer options map directly to Engineer actions, for example `retry | wait | escalate`.
- The probabilities support confidence thresholds. If no option is above the threshold, or Clef is unavailable, the Engineer keeps its deterministic default instead of guessing.
- Clef runs only *after* the hard gates pass. It can never override them.

The Engineer currently asks Clef two questions, both within the Station's automatic retry allowance:

- **A Station run failed** (`retry | wait | escalate`). A confident `retry` or `wait` starts the run again, immediately or after a pause, and uses up one automatic retry. The default is to block, as before.
- **The Conductor returned work** (`revise | escalate`). A confident `escalate` stops the revision loop early and asks the user. The default is another revision, up to the cap.

## The Engineer as the Train's Voice to Dispatch

The Engineer is how a Train reports to the Dispatcher. It notifies the Dispatcher when:

- it reaches a gate the Dispatcher controls, such as being ready to enter Terminus or waiting on a Station in another Line
- something is wrong, such as being blocked, held for a long time, or failing repeatedly
- Clef judges that the Dispatcher should know

Routine movement, such as clearing a normal departure or waiting for a Station that isn't ready yet, is **not** reported to the Dispatcher.

This only controls what the Dispatcher **hears**. It never controls what gets **recorded**. Every state change writes its event to the event log no matter what, so the map and the audit trail always show the full picture.

---

# 17. Source-of-Truth Rules

There should be exactly one clear owner for each kind of state.

| Information                 | Owner                          |
| --------------------------- | ------------------------------ |
| Source code                 | Artifacts                      |
| Git history                 | Artifacts                      |
| Canonical integrated code   | Terminus Artifact              |
| Train integrated code       | Train Artifact                 |
| Station proposed code       | Station Artifact               |
| Network topology            | Domain + D1                    |
| Train status                | Domain + D1                    |
| Station status              | Domain + D1                    |
| Station Manifest            | Domain + D1                    |
| Domain event log            | D1 (same batch as the change)  |
| Writes to a Train's state   | That Train's Workflow only     |
| Agent execution             | Sandbox                        |
| Durable process execution   | Workflows                      |
| AI reasoning                | Agent Runtime / Model Provider |
| Business rules              | Domain                         |
| Visual state                | React                          |
| Animations                  | React                          |
| User commands               | Worker API                     |
| Accepted change explanation | Car/domain metadata            |

Avoid creating multiple authoritative copies.

---

# 18. End-to-End Example

A typical Station lifecycle should look approximately like this:

```text
User
 ↓
React
 ↓
Worker API
 ↓
Dispatcher
 ↓
Domain creates Line + Stations
 ↓
D1 stores topology
 ↓
Artifacts forks Train from Terminus
 ↓
Train departs
 ↓
Workflow activates next Station
 ↓
Artifacts forks Station from current Train
 ↓
Sandbox starts
 ↓
Station Agent (OpenCode) receives Manifest
 ↓
Agent edits/tests/commits code; process exits
 ↓
Workflow runs validation, collects evidence
 ↓
Changes pushed to Station Artifact
 ↓
Station = ready_for_pickup
 ↓
Train arrives
 ↓
Conductor reviews candidate
 ↓
Domain validates acceptance
 ↓
Accepted changes fast-forwarded onto Train Artifact
 ↓
Car recorded in D1
 ↓
Train departs toward next Station
```

The UI observes these state changes and makes the network visually come alive.

It does not drive them.

---

# 19. Technologies We Should Not Introduce Without a Reason

Do not add infrastructure merely because Cloudflare provides it.

In particular, avoid introducing additional state systems unless a concrete requirement appears.

For the initial architecture:

- **Artifacts** handle code/versioned filesystem state.
- **D1** handles application metadata.
- **Workflows** handle durable processes.
- **Sandboxes** handle executable development environments.
- **Workers** handle API/integration logic.
- **Workers AI / AI Gateway** handle model access.
- **React** handles presentation.

Custom Durable Objects, Queues, R2, KV, Vectorize, or additional databases should only be introduced when a specific requirement makes them appropriate.

The Durable Object binding that the Sandbox SDK requires is part of using Sandboxes. It does not count as a custom Durable Object.

Artifacts push notifications (event subscriptions) are not used, because they need a separate subscription for every repository and are delivered to a Queue. Station completion is detected when the harness process exits instead.

The goal is not to demonstrate every Cloudflare product.

The goal is to create a coherent agent-native Git platform using a small number of primitives with clearly defined responsibilities.

---

# Final Architectural Rule

Whenever it is unclear where new code belongs, ask:

> **Who owns this concept?**

If it describes **what a Train, Station, Car or Agent is allowed to do**, it belongs in the domain.

If it **stores versioned project files**, it belongs in Artifacts.

If it **stores queryable platform metadata**, it belongs in D1.

If it **coordinates something that may take a long time or need retries**, it belongs in Workflows.

If it **executes code**, it belongs in a Sandbox.

If it **calls or configures an AI model**, it belongs behind the agent runtime/model provider.

If it **connects those systems to the outside world**, it belongs in the Worker.

If it **draws something or handles user interaction**, it belongs in React.

Maintaining these boundaries is more important than the exact folder structure or individual library choices.

### Unloading policy and approval ownership

Dispatcher-owned `train_unload_policies` records in D1 hold each Train's effective unload mode, the planning recommendation, and any approval of an exact accepted Train commit. They are permissions, not a second copy of Train lifecycle state. The Train Workflow evaluates the domain gate and alone records a `held` approval wait or its release. The review yard is the UI projection of that reason; Siding remains terminal abandonment. An unapproved Train is excluded from clearance eligibility. D1 atomically checks permission when reserving clearance and closes policy edits while that reservation is active. Integration still validates and promotes an exact merge candidate against current Terminus; approval does not authorize a changed Train or bypass checks.

## Crossing integration boundary

Crossings are first-class, one-way pickup visits in ordered Line routes. Source Stations retain one implementation owner and a frozen acceptance checkpoint. Cars copied onto receiving Trains preserve their origin and commit identities; compatibility review and merged-candidate evidence are recorded separately. The shared Integration Workflow reserves one target repository, prepares and validates an isolated candidate, and promotes the exact reviewed commit. Only the receiving Train Workflow records pickup completion and changes that Train's state. Terminus remains the sole canonical project state. See [Crossings](crossings.md) and AGENTS.md for configuration, failure handling, and demonstration instructions.

## Junction execution

Junctions use the same Artifacts, D1 and Workflows boundaries. One Junction Workflow schedules serial input integrations and owns feature lifecycle state; each Train Workflow still owns Train state. Every feature input starts from one frozen Terminus baseline. The shared Integration Workflow has explicit Terminus, Crossing and Junction purposes with per-target reservations. It independently validates and reviews merge candidates before exact fast-forward promotion. Junction receipts retain target exclusion until head, membership ledger, provenance and events are acknowledged atomically.

Complete feature checks/review and commit-bound human release create one outgoing Train with original Car provenance and the frozen baseline. Outgoing Stations fork that released head and final canonical integration merges any newer Terminus work. Technician repairs stay isolated, bounded, independently reviewed/validated and separately approved. See [Junctions](junctions.md) for full ownership, topology, failure recovery and verification.
