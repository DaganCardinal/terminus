# AGENTS.md

Guidance for coding agents working on the Terminus codebase.

Terminus is an orchestration platform that coordinates many coding agents working on one shared codebase. It uses a railway network as its coordination model, and it runs on Cloudflare with **Cloudflare Artifacts** as its Git layer.

> **Project status:** the domain core, D1 persistence and event log, Train, Station, and Terminus integration Workflows, Worker API, and React/SVG railway map are implemented. Real Artifacts/Git and Sandbox harness Station execution (OpenCode by default), independent validation, and Conductor review are available alongside an offline fake environment. Every Conductor review (Station, Crossing, Junction input and feature, Technician repair) runs with its frozen harness configuration (OpenCode by default) that builds and runs the exact candidate before deciding; it is implemented and needs live verification. The maintainer verified both concurrent Trains reaching and integrating into Terminus in a live test. Dispatcher planning (goal → read-only OpenCode exploration with `explore` subagents → persisted proposal → explicit launch) is implemented and needs live verification. Technician reconciliation of failed Terminus merges (isolated candidate → independent validation → Conductor review → explicit approval → integration) is implemented and needs live verification. Per-Line unload recommendations, user selections, and commit-bound human unloading approval are implemented and verified in the offline demo; the new gate needs live verification. The Engineer's Clef decision model (`ModelEngineer` → `GatewayDecisionModel` → Workers AI `/ai/run`) triages failed Station runs (retry, retry after `STATION_RETRY_BACKOFF`, or block) and may stop a Conductor revision loop early (`engineer_escalated`); both need live verification. Its `notify_dispatcher` question is defined but not yet consulted. If a decision isn't covered here or in `docs/`, ask the maintainer instead of assuming.

## Project context

Junction convergence, feature acceptance, human release, downstream routes, repairs and map/details are implemented and verified offline. Live Artifacts/Sandbox Junction verification remains maintainer-owned; see `docs/junctions.md`.

- Terminus is being built as an entry for Cloudflare's "next Git platform" competition. **The submission deadline is October 14, 2026.** The project must use **Cloudflare Workers** and **Cloudflare Artifacts**. The minimum bar is a demo of multiple agents working on changes concurrently.
- The submission must include a 5–10 minute demo video, source code under a permissive open-source license (MIT; see `license.md`), and instructions for running the project. Prioritize work that makes the end-to-end concurrent-agent flow real and demonstrable.
- The Terminus source code is hosted on GitHub. The *projects Terminus manages* live in Artifacts.
- `../terminus-demo-app` (a sibling of this repo) is the local demo project for testing Terminus end to end.

## Design docs

Read these when you need more depth:

| Doc | Covers |
| --- | --- |
| `README.md` | Fake development quick start, checks, and an index of the guides below |
| `docs/live-setup.md` | Live Artifacts/Sandbox setup, agents and models, provider routing, deployment |
| `docs/station-execution.md`, `docs/terminus-integration.md` | Execution constraints, evidence, Conductor review, integration and recovery |
| `docs/dispatcher-planning.md`, `docs/unloading.md`, `docs/technician.md`, `docs/crossings.md`, `docs/previews.md`, `docs/publishing.md`, `docs/api.md` | Feature behavior, setup and API examples |
| `docs/outline-updated.md` | Concept model, roles, Train/Station states, events, topology, architecture |
| `docs/technology-architecture.md` | Technology stack, what each technology owns, source-of-truth rules |
| `docs/structure-and-ownership.md` | Layer ownership, dependency direction, where code belongs |
| `docs/agent-roles.md` | Role responsibilities and execution flow (older; uses outdated state names) |

**When the docs disagree, this order wins:** this file, then `outline-updated.md` and `technology-architecture.md`, then the other two docs. The docs are build-time references and may be removed after launch, so don't make runtime code depend on them.

---

## The governing rule

> The railway network is the domain model. The map is a projection of that model, not the system itself.

- **If a change affects what the system means or what happens next, it belongs on the backend/domain side.**
- **If a change affects how current state is displayed or interacted with, it belongs in the UI.**

Orchestration must keep working correctly when no browser is connected. Refreshing the browser must never change the workflow.

When you're unsure where code belongs, ask **"who owns this concept?"** (see [Where code goes](#where-code-goes)).

---

## Glossary

Use these terms precisely. They are not aliases for Git concepts.

| Term | Meaning |
| --- | --- |
| **Project** | One managed codebase, backed by one canonical Terminus repository in its own Artifacts namespace. |
| **Network** | All the Lines, Trains, and Stations for a Project, coordinated by one Dispatcher. A Project has exactly one Network. |
| **Terminus** | The canonical project state. It is **not** just `main`. Only a Train that passes integration checks is promoted into it. |
| **Line** | An ordered workstream that runs from a distant **depot**, through its Stations, to Terminus. It is not a branch. Lines do not branch. A configured one-way Crossing visits another Line's Station to merge its accepted checkpoint, copy missing Cars with provenance, and continue on the receiving Line. |
| **Station** | One clearly defined task, defined by a Work Manifest. It is not an issue. |
| **Work Manifest** | The structured definition of a Station: goal, scope, expected areas, areas to avoid, contracts, invariants, dependencies, acceptance criteria, and expected evidence. It is a first-class domain object stored in D1, never just a prompt. |
| **Train** | The evolving integration snapshot for a Line. It is not a branch. Incoming and ordinary Train repositories fork Terminus; outgoing Junction Trains fork the approved feature head and retain the frozen Terminus baseline. Each Train accumulates accepted work in order and owns its own state. |
| **Car** | One accepted unit of work on a Train. It is not a commit. A Car is a D1 domain record with provenance (manifest, agent config, source and accepted commits, diff, evidence, review) that references the Train repository. It has no repository of its own. |
| **Depot** | The far end of a Line, where its Train is created. |
| **Review yard** | A map area for completed Trains held for human unloading approval. They remain resumable and do not reserve Terminus clearance. |
| **Siding** | A separate map area where abandoned Trains are parked. They stay inspectable but no longer run. |
| **Signal** | The map's view of an Engineer's current gate decision (green or red). It is never stored as separate state. |

### Roles

| Role | Owns | Never |
| --- | --- | --- |
| **Dispatcher** | The user's conversational interface. Plans goals into Lines, Stations, and manifests. Creates Trains. Maintains network-level state (topology, cross-Line dependencies, holds). Forecasts collisions between Lines. Handles issues raised by Trains and alerts the user when needed. | Implements product code or micromanages individual Trains |
| **Conductor** (one per Train) | Is in charge of its Train. Reviews Station work against the manifest and the Train's current state. Accepts work and attaches Cars, returns work for revision, or raises the issue to the Dispatcher. | Does the Station Agent's implementation work |
| **Engineer** (one per Train) | Deterministic movement control: whether the Train may depart, continue, wait, retry, or stop. Checks dependencies and holds. Controls signals. Uses a decision model (Clef by default) only for choices the hard rules don't settle. **The Train's voice to Dispatch:** it notifies the Dispatcher at gates the Dispatcher controls (such as entering Terminus or cross-Line waits), when something is wrong, or when Clef judges the Dispatcher should know. It never reports routine movement. | Overrides a hard rule, or acts as a general-purpose agent |
| **Station Agent** | Implements one manifest in an isolated Station workspace, using a coding-agent harness (OpenCode by default) inside a Sandbox. Commits proposed work. | Accepts its own work, writes to the Train, or writes to Terminus |
| **Technician** | Rare cases only: conflicts, incompatible contracts, failed integrations. Works in an isolated workspace and produces a reviewable candidate change with provenance. | Silently rewrites a Train or Terminus |

**Dispatcher implementation:** the Dispatcher is one role with two halves. The deterministic half applies commands, records topology, receives issues from Trains, and persists state. The model-driven half handles conversation, decomposition, manifests, forecasting, and responses to escalations. A model's output becomes state only after it is validated and applied as a domain command.

---

## States and events

Canonical definitions are in `docs/outline-updated.md` (see "Train States" and "Station States"). Once `packages/domain` exists, its definitions are authoritative.

**Train states:** `ready` · `in_transit` · `approaching` · `docked` · `reviewing` · `held` · `blocked` · `returning` · `unloaded` · `siding`

- There is no "departing" state. `train.departed` is the event that moves a Train from `ready` to `in_transit`.
- A `held` Train is stopped by an expected condition (a user hold, sequencing, or an unmet dependency) and resumes on its own when the condition clears. A `blocked` Train has hit a problem and needs intervention.
- During a revision, the Train stays `docked`.
- The two terminal states: `unloaded` means the Train's work was accepted into its configured destination and it is removed from the map (its Cars stay in history). A Junction destination is feature convergence, not canonical integration; legacy unload records mean Terminus. `siding` means the Train was abandoned and parked on the siding.

**Station states:** `waiting` · `signaled` · `active` · `ready_for_pickup` · `in_review` · `revising` · `blocked` · `complete` · `cancelled`

**Naming conventions:**

- State values are lowercase snake_case.
- Events use `entity.snake_case`, for example `car.attached`, `station.signaled`, or `train.issue_raised`.
- When choosing between a generic name and a railway-metaphor name, **prefer the metaphor**.
- Events describe domain changes. They are never UI instructions like `moveTrainToX` or `showLoadingSpinner`.
- The activity feed and audit trail are built from the same events. Do not keep a separate log representation.

---

## Technology stack

| Concern | Technology | Owns | Does not own |
| --- | --- | --- | --- |
| Language | TypeScript (monorepo) | — | — |
| Frontend | React + Vite, shadcn/ui | Rendering, interaction, animation, local UI state, command submission | Orchestration, lifecycle transitions, canonical state |
| Map | React-based 2D (SVG, Canvas, or DOM) | Visualizing Trains, Stations, Lines, signals | Anything in the domain. No Three.js or 3D. |
| API | Cloudflare Workers | The HTTP boundary, auth, command handling, infrastructure adapters | Lifecycle rules |
| Durable execution | Cloudflare Workflows | Long-running steps, retries, waiting, recovery | Deciding what the lifecycle *means* |
| App data | Cloudflare D1 | Queryable metadata: topology, statuses, manifests, Cars, agent runs, repo IDs, commit refs, workflow IDs | Source trees, Git history, file contents |
| Code / Git | Cloudflare Artifacts | Every repository: Terminus, Trains, Stations, Technician workspaces | Workflow or UI state |
| Code execution | Cloudflare Sandboxes + configured harness (OpenCode default) | Isolated environments where agents clone, edit, build, test, and commit | Anything durable. Losing a Sandbox must lose nothing accepted. |
| AI | Workers AI + AI Gateway; Clef for Engineer decisions | Model execution and routing behind a `ModelProvider` abstraction | Role identity |

**Do not add infrastructure without approval.** This includes custom Durable Objects, Queues, R2, KV, Vectorize, or another database. The Durable Object binding that the Sandbox SDK requires is part of using Sandboxes and is fine. The goal is a coherent system built from a few primitives, not a tour of Cloudflare products.

**Never hardcode model IDs.** Code asks for a role or capability, and the model is configuration. Users will be able to configure models per role in the future. Default model choices are listed in `docs/technology-architecture.md`. Where practical, configure the Conductor with a different model family from the Station Agent.

---

## Execution model

These decisions are settled. The details are in `docs/technology-architecture.md`.

- **Workflows:**
  - **One Train Workflow per Train.** It runs the whole lifecycle from the depot to `unloaded` or `siding`, and it is the **only writer** of that Train's state. The Dispatcher, the user, and Station Workflows send events to it and never write the Train's state directly.
  - **One Station Workflow per Station run.**
  - **One shared Integration Workflow per integration attempt**, with explicit Terminus, Crossing or Junction purpose and exact source/target snapshots.
  - **One Junction Workflow per Junction**, owning its lifecycle and serializing convergence. Train Workflows remain their Trains' only state writers.
  - **One Dispatch Workflow per planning request.** It prepares a persisted proposal, waits for an explicit launch command, lays all planned Lines atomically, and starts their Train Workflows with stable identities.
- **Station execution:**
  1. Fork the Station repo from the Train. (A Train with no Cars is still at its Terminus commit, so its first Station forks Terminus at that exact commit instead: Artifacts can refuse to fork a fork that young. See `docs/station-execution.md`.)
  2. Issue a short-lived token that can write only to the Station repo.
  3. Start a Sandbox, clone the repo, and write the manifest into it.
  4. Run the frozen harness adapter (OpenCode by default; Claude Code and Codex behind the release gate below).
  5. Wait for the process to exit.
  6. **Our code** runs validation and collects evidence. Never use the agent's own summary as evidence.
  7. Push, then mark the Station `ready_for_pickup`.
- **Every coding harness (Dispatcher, Station, Technician, Conductor, and any future role) runs over an untrusted checkout through one path:** `prepareHarness` in `apps/worker/src/integrations/harness.ts` with a `HarnessAgent` from `packages/agent-runtime`. Roles declare capability profiles; only shared adapters translate those into harness configuration.
  - The role's instructions are its own primary agent's system prompt, followed by the shared `repositoryContentPolicy`. OpenCode's built-in agents are disabled except read-only `explore`, and skills are denied.
  - `opencodeEnvironment` sets `OPENCODE_DISABLE_PROJECT_CONFIG` and `OPENCODE_DISABLE_CLAUDE_CODE`, so repository OpenCode config, agents, plugins and root `AGENTS.md`/`CLAUDE.md` never become instructions.
  - A preflight immediately before each start removes user-level OpenCode, Claude and Codex config (repository install scripts may have written it) and reads the root `AGENTS.md` (else `CLAUDE.md`), capped and without following symlinks. It is attached to the first message as data inside a random-boundary `<repository-guidance>` block.
  - OpenCode still appends nested `AGENTS.md` files to read-tool output; the policy tells the agent they are repository content.
- **Completion is detected when the harness process exits and its adapter confirms a successful final outcome.** Do not use Artifacts push notifications for this. They need a subscription per repository and are delivered to a Queue.
- **Dispatcher planning** runs the selected read-only harness (OpenCode by default) in a Sandbox at the exact Terminus commit. OpenCode may delegate only to its read-only `explore` subagent, which runs on the role's `utilityModel` (`@cf/zai-org/glm-5.3-flash` for Workers AI roles); other adapters do not enable subagents.
  - Optional baseline checks run first, with repository read access and no model access. Secret files and Git history are then removed, repository access is dropped, and only the configured model stays reachable.
  - Every limit is a `deny` rule, because `--auto` approves everything else.
  - With OpenCode, the Dispatcher submits its proposal through the `terminus_submit_proposal` tool, which the Sandbox outbound handler serves (a minimal remote MCP server in the Worker) and which checks schema and assessment while the session can still fix them. The check is advisory. Remaining schema and assessment problems are corrected in the same session (at most two corrections). The proposal still becomes state only after validation, and launch still requires the explicit user command.
  - A failing baseline gets an optional `baselineFix` Line. If the user includes it, every other top-level Line picks up the fix through a Crossing before its first Station.
- **Every Conductor review** runs the frozen Conductor harness in a Sandbox over a sealed checkout of the exact candidate commit under review: Station work (`HarnessConductor.review`), Crossing handoffs (`reviewCrossing`), Junction inputs and features (`reviewJunction`), and Technician repairs (`HarnessRepairConductor`). All share `verifyInHarness` and `SandboxConductorSessions`; each kind supplies only its own guidance, review files and summary. The Conductor reads, builds, tests, and runs the app end to end before deciding.
  - Orchestration checks out the candidate with read access to the repository holding it only (Station, integration candidate, Junction, or repair workspace), runs `npm ci` with no model access, fingerprints the tracked files, removes secret files and `.git`, then drops repository access, leaving only the model reachable. No Conductor Sandbox ever holds write access to any repository.
  - The agent may run commands, but edit tools, web tools and skills are denied, and outside the checkout it may reach only `/workspace/review` (the patch, check output and review input) and `/tmp`. If tracked files changed when it finishes, the review is discarded, because it no longer describes the candidate.
  - Every review runs in its own Workflow step with one retry, because a session takes minutes and is paid; the verdict is durable before anything acts on it. Preparation (access, checkout, install, sealing, trusted checks) runs before the model is reachable, so its failures are retried in place in a fresh session (after 10s, then 30s) without spending that retry:
    - **Station:** Train Workflow `review` step (30 minutes). `advanceTrain` returns `review`, `reviewStation` records the verdict in `conductor_reviews`, and the next advance applies it. A review that cannot produce a valid verdict (at most two in-session corrections) blocks the Train and Station with `review_escalated`.
    - **Crossing and Junction input:** Integration Workflow `Conductor review` step (30 minutes) between merge/validation and promotion. `reviewIntegration` records the review on the attempt; promotion only applies it (and reviews itself only if the step was skipped). A failed review fails the attempt through the existing reconciliation path.
    - **Junction feature:** `advanceJunction` returns `review`, and the Junction Workflow runs `reviewJunctionFeature` (feature validation plus review, 45 minutes), which moves the Junction to `ready` or `blocked`.
    - **Technician repair:** the existing `Conductor reconciliation review` step (now 30 minutes, one retry).
  - Failed required checks and a missing Station diff still decide without a session. With fake repositories, every Conductor review is a direct model call on the supplied diff.
- **Harness selection and release:** Settings → Agents offers OpenCode (default), Claude Code and Codex per harness role. OpenCode supports Workers AI, Anthropic and OpenAI; Claude Code supports Anthropic; Codex supports OpenAI Responses. Curated metadata in `packages/protocol/src/models.ts` owns model compatibility, native IDs, versions and cost ordering. No custom IDs or runtime fallback. The image pins OpenCode 1.18.32, Claude Code 2.1.280 and Codex 0.156.1; preparation verifies the installed version. Native adapters disable repository instructions/configuration, discovery, hooks, skills, plugins, telemetry and updates, and retain disposable native session files for corrections. Restrictive profiles fail closed; never add permission bypasses to get a harness running.
- **Frozen execution:** `execution_configs` captures immutable configuration atomically when Trains, plans, repairs (including their Conductor), and Junctions are created. Station revisions and review/recovery paths reuse it; settings affect new work. Preserve old cached Workflow step shapes and historical provenance as OpenCode. `ALTERNATIVE_HARNESSES_ENABLED` gates real alternatives, including external-provider OpenCode models; the maintainer has enabled it in the real deployment, with [the live verification checklist](docs/harness-selection.md#release-verification) still outstanding. Fake execution accepts every settings combination without provider calls. The GLM-only testing rule below still applies; new-provider live checks need explicit maintainer authorization.
- **Non-harness roles:** the Engineer's Clef model is called directly through a `DecisionModel` (typed questions → per-option probabilities), never a text `ModelProvider`. It is consulted only after the hard gates clear, with a compact `StationBrief` (never diffs). Below `ENGINEER_CONFIDENCE_THRESHOLD`, or when the model fails, the deterministic default stands: a failed run blocks, returned work is revised. `FakeEngineer` keeps those defaults, so offline and test behavior is unchanged unless a test configures it.
- **Model credentials never enter a Sandbox.** The Worker's outbound handler strips provider authentication and gateway-control headers, then injects trusted AI Gateway authentication for the exact granted provider endpoint and native model, plus that model's `utilityModel` (the provider's lowest-cost model, used only for harness housekeeping such as session titles and OpenCode's read-only `explore` subagent). Streamed Workers AI calls with no response headers after `modelHedgeAfterMs` (8s) get one copy without session affinity; the first successful answer wins and the other is aborted. Anthropic/OpenAI calls are paid through AI Gateway Unified Billing (no provider key stored under the gateway's `default` alias, which would take precedence); Terminus never handles provider keys.
- **The UI polls.**
  - It loads a snapshot, then polls `GET /networks/:id/events?after=<seq>`.
  - Each state change and its domain event are written in the **same D1 batch**.
  - No WebSockets or Durable Objects without approval.
- **Onboarding:**
  - Each Network owns one Artifacts namespace (`terminus-<network id>`). Every repository it uses lives there, and repository ids are `<namespace>/<name>`. Forks never leave their namespace. Terminus reaches Artifacts through its REST API, because the Workers binding is fixed to one namespace.
  - One Network per Project: a source URL already imported by another Network is refused (`409`, with that `networkId`).
  - A project's Terminus repo is created by importing a public Git URL, or by `create()` followed by an initial push.
  - Code is retrieved with `git clone`.
  - There is no GitHub sync, and importing private repos is out of scope.
- **Publishing:** an explicit user command forks Terminus into the namespace's `publish` repository at the displayed canonical commit, then only fast-forwards it. Workers Builds, connected once in the dashboard, deploys that repository. Terminus holds no deployment credentials, and promotion never publishes. See `docs/publishing.md`.

## Architecture and ownership

The exact filenames may change. **The ownership boundaries may not.**

```text
apps/
  web/            # React app: 2D network map, panels, decisions (presentation only)
    components/ map/ views/ state/
  worker/         # Worker entry: API, workflows, deployed role instances, infra adapters
    api/ agents/ workflows/ integrations/
packages/
  domain/         # Pure TS: concepts, states, transitions, invariants, Engineer gate rules, events
  protocol/       # Commands, events, snapshots, API contracts, agent request/result schemas
  agent-runtime/  # Role runtimes (prompts, tools, structured outputs) + ModelProvider abstraction
  artifacts/      # Artifacts/Git repository operations
  ui/             # Shared React components with no orchestration knowledge
```

### Where code goes

| If the code... | It goes in |
| --- | --- |
| Defines what a Train, Station, Car, or role is allowed to do (transitions, invariants, gate rules) | `packages/domain` |
| Is a shape that crosses a process boundary | `packages/protocol` |
| Defines a role's prompts, tools, or structured output, or calls or configures a model | `packages/agent-runtime` |
| Creates, forks, or diffs repositories, records commit identities, or applies accepted work to a Train | `packages/artifacts` |
| Coordinates something that may take a long time or need retries | `apps/worker/workflows` |
| Connects systems to the outside world (HTTP, D1 access, Sandbox access, bindings) | `apps/worker/api`, `apps/worker/integrations` |
| Is the deterministic half of the Dispatcher, or wires a role to infrastructure | `apps/worker/agents` |
| Draws something or handles user interaction | `apps/web` |

**Do not put behavior in `/scripts`, `/utils`, or `/helpers`.** Scripts are only for true one-off dev or maintenance tasks.

### Dependency direction

Dependencies point inward, toward the domain.

- `packages/domain` must **not** import React, Worker, Workflows, Agents, D1, Sandbox, or Artifacts APIs, model SDKs, or anything that runs Git. Outer layers adapt those to domain interfaces.
- `apps/web` talks to the backend only through `packages/protocol` and application-level commands such as `createLine()` or `pauseTrain()`. It never uses infrastructure primitives such as `createArtifactsRepo()`.
- Agent adapters return protocol-defined shapes. Validate model output with the Zod schemas from `packages/protocol` before acting on it.

### Source of truth

Each kind of state has exactly one owner. Never create a second authoritative copy.

- **Artifacts** owns code and history: Terminus, Train, Station, and Technician repositories.
- **Domain + D1** own network topology, Train and Station statuses, manifests, and Cars.
- **Workflows** own process execution. **Sandboxes** own agent execution. **React** owns visual state and animation.
- A manifest copied into a Station workspace is context for the agent, not a source of truth.

---

## Invariants to preserve

### State and UI

- The backend owns the truth, and the frontend renders it. The UI never decides whether a Train may move, never infers completion from an animation, never merges, and never runs workflows.
- Animation never drives state. The order is state change → agent behavior → visualization.
- `in_transit` means work is in progress. It is **not** a progress percentage or a timer. A Train moves to `approaching` because its Station became `ready_for_pickup`. The map eases a moving Train toward a waiting point short of its next Station as presentation only; it never draws the Train at the Station before `approaching`.
- Movement must never hide a blocker. `held` and `blocked` must be explicit in the domain and visible on the map.

### Topology and the work loop

- Lines radiate out from Terminus. A Train is created at its Line's depot and runs **toward** Terminus. In the repository model, the Train's repo is still forked from Terminus when the Train is created. That gap between map and repo is intentional.
- **Departure starts work.** A Station's workspace is forked from the Train's current state *when the Train departs toward it*, not when it arrives.
- Finishing a Station does not add its work to the Train. Only the Conductor's acceptance creates a Car. After acceptance, the Car is on the Train *before* the next Station is signaled.
- Each Train runs its own lifecycle under its Conductor and Engineer. The Dispatcher is involved only when the Engineer notifies it.
- What the Dispatcher is told is selective. What gets **recorded** is not. Every state change writes its event, whether or not the Dispatcher is notified.
- Hard rules are enforced in the domain, and no model can override them:
  - failed required tests → the Train cannot depart
  - unresolved conflict → the Train cannot depart or integrate
  - incomplete dependency → the dependent Station cannot be signaled
  - user hold → the Train cannot proceed
  - Conductor rejection → the work returns to the Station
  - Station revision allowance exhausted → Engineer blocks the Train and Station, flags the Dispatcher, and the Dispatcher flags the user

- Station execution permits one initial attempt plus at most three automatic revisions by default (`STATION_MAX_RETRIES`). Required-check failures, Conductor returns and Engineer retries of failed runs (`retryStationRun`, a new run ID suffixed `-f<n>`) share the allowance, and the Engineer may stop revising early with `engineer_escalated`, which alerts the user like an exhausted allowance. A failed final revision raises `station_retries_exhausted` and a persisted `dispatcher.user_attention_requested` event. Only explicit intervention/Train clearance grants a fresh allowance; retain lifetime revision history, the latest rejected candidate, feedback, and validation evidence. This allowance is separate from infrastructure step retries.

### Integration, provenance, and security

- **Applying accepted Station work to a Train is always a fast-forward.** Artifacts has no merge API, so the push goes over the Git protocol from orchestration code, never from the Station Agent. If the Train has moved since the Station was forked, re-review the work. Never force it.
- Unload policy and commit-bound human approvals are Dispatcher-owned D1 metadata, separate from Train state. The Engineer enforces human approval only at the final Terminus gate; the Train Workflow records the approval hold. Policy freezes once integration clearance is reserved. Approval never overrides other hard gates.
- Only the final integration process writes to Terminus. Before promotion, check how far Terminus has moved since the Train was created and run project-wide validation.
- **Terminus integration uses merge commits. Never rebase or squash,** because Cars reference accepted commit IDs. Never hide unresolved conflicts behind automatic merges. A conflict becomes an issue raised to the Dispatcher.
- Declared intent helps with planning, but actual changes decide. Compare manifests against real diffs and evidence, and surface anything out of scope.
- Separate repository copies do not make Lines independent. Forecast collisions from manifests, then refine the forecast with actual changes.
- Give each Station Sandbox only the repo-scoped credentials its job needs. **A Station Sandbox must never get credentials that can modify Terminus or a Train.**
- Anything durable must be committed to Artifacts or recorded in D1 before a Sandbox can disappear.

---

## Toolchain

- **Package manager:** npm, with npm workspaces for the monorepo. Do not introduce pnpm, yarn, bun, Turborepo, or Nx.
- **Node:** 24 (the maintainer's current system version). Pin it in `engines` and `.nvmrc` when scaffolding.
- **Tests:** Vitest. Use `@cloudflare/vitest-pool-workers` for anything that runs in the Workers runtime (`apps/worker`, and integration with bindings). Use plain Vitest for pure packages like `packages/domain` and for `apps/web`.
- **Lint and format:** ESLint (flat config, with `typescript-eslint`, plus the React Hooks and React Refresh plugins for `apps/web`, as in Vite's React + TypeScript template) and Prettier. Use one shared root config. Don't add extra rule sets without asking.
- **Runtime validation:** Zod. Schemas live in `packages/protocol`. Use them to validate everything that crosses a boundary: API requests, events, agent and model output, and harness JSON events.
- **Deploy and local dev:** Wrangler.

### Commands

Run these from the repo root:

| Command | Does |
| --- | --- |
| `npm install` | Installs all workspaces |
| `npm run dev:web` | Starts the Vite dev server for `apps/web`, proxying `/api` to the Worker on port 8787 |
| `npm run dev:worker` | Applies local D1 migrations, then starts real Artifacts/Sandbox execution (requires live setup in `docs/live-setup.md`) |
| `npm run dev:fake` | Applies local D1 migrations and starts the Worker with fake repositories and roles; no credentials required |
| `npm run build` | Builds every workspace that has a `build` script (currently `apps/web`) |
| `npm run typecheck` | Type-checks every workspace |
| `npm test` | Runs Vitest in every workspace (`apps/worker` runs in the Workers runtime) |
| `npm run lint` | Lints the repo with the root ESLint config |
| `npm run format` / `npm run format:check` | Formats or checks code with Prettier (Markdown is ignored) |

Workspace-specific commands:

- Add a shadcn component: `npx shadcn@latest add <component> -c apps/web`. Components are written to `packages/ui/src/components` and imported as `@terminus/ui/components/<name>`.
- Regenerate Worker binding types after editing `apps/worker/wrangler.jsonc`: `npm run cf-typegen -w @terminus/worker`.
- During implementation/testing, **all real roles use `@cf/zai-org/glm-5.3-flash`** per maintainer instruction. Do not substitute the more expensive design-doc defaults or introduce an automatic fallback.
- Role models are user configuration stored in D1 (`model_settings`): General settings, optionally overridden per network, chosen from presets in `packages/protocol/src/models.ts`. The default preset (Extra-light) keeps every text role on `@cf/zai-org/glm-5.3-flash`. Workflows resolve a network's models in a durable step when work starts, so in-flight work keeps its models. The Worker vars `STATION_AGENT_MODEL`, `CONDUCTOR_MODEL`, `DISPATCHER_MODEL`, `TECHNICIAN_MODEL`, `ENGINEER_MODEL` only switch a role to `fake` (runs without a model); `FAKE_AGENT_DELAY_MS` and `FAKE_CONDUCTOR_RETURNS` tune the fakes.
- Workspace packages are source-only TypeScript (`exports` points at `src/index.ts`). Vite and Wrangler compile them, so they have no build step.
- Vitest is pinned to v4 because `@cloudflare/vitest-pool-workers` doesn't support v5 yet.

## Code and testing conventions

- Use TypeScript `strict` mode. Avoid `any`. Model domain states as discriminated unions or string literal unions, and model transitions as explicit functions that reject invalid moves.
- Put unit tests next to the code they test (`foo.ts` → `foo.test.ts`) in every package and app. A top-level `tests/` directory is only for cross-package integration and end-to-end tests.
- The entire railway lifecycle must be testable **without** rendering UI, calling a model, starting a Workflow, using a Sandbox, or touching a real repository. If a domain test needs any of these, the boundary is wrong.
- Every transition and hard gate rule needs a direct unit test.
- Build the orchestration engine before visual polish. A plain status view is fine until the loop works end to end: Station work, repository updates, Conductor review, Car attachment, conflict detection, and the event history.

## Git workflow

**The human maintainer handles all commits, branches, and pull requests.** Do not commit, create branches, push, or open PRs unless explicitly asked. Leave your changes in the working tree.

## Crossings

- A Crossing is a pickup-only visit to a Station owned by another Line in the same Network. It never executes or changes the source Station. Crossings are configured when laying Lines; running routes stay fixed.
- `Line.stops`, when present, owns route order. `stationIds` is its owned-Station compatibility projection; old Lines use Station-only routes.
- Source acceptance atomically records an immutable checkpoint (repository, exact commit, ordered Cars). Pickup includes all work through that checkpoint, including imported Cars, and excludes later source work. The source Train continues independently.
- The receiving Train keeps its Cars and copies only missing original Cars, preserving accepted commits, manifests, evidence, and reviews. The receiving Conductor's compatibility review belongs to the integration attempt.
- Crossing merges use the shared candidate/validation/promotion machinery. They are an explicit exception to the pre-Terminus merge rule; ordinary Station acceptance remains a fast-forward. Only Terminus integration writes canonical project state.
- Line exchange must be an acyclic one-way flow. No reciprocal exchanges, source manifest reruns, cherry-picking, rebasing, or squashing. Failed handoffs block and alert the Dispatcher; retry is explicit and Crossing Technician repair is deferred.
- Integration reservations are per target repository. Uncertain promotions retain their reservation and must be reconciled before retry or siding. The receiving Train Workflow alone changes its Train state and completes pickup.

## Junctions

- A Junction is a first-class feature convergence repository, never canonical Terminus. Its feature brief is a D1 domain object, not an implementation Station. `docs/junctions.md` covers ownership, API, recovery and verification.
- One Junction Workflow alone writes its lifecycle (`collecting`, `reviewing`, `ready`, `released`, `blocked`, `abandoned`) and serializes input scheduling. Train Workflows remain their Trains' only state writers.
- Incoming Lines end at a Junction; its outgoing Line originates there and may have zero Stations. Membership, routes and the Terminus baseline freeze at launch. V1 supports independent Junctions, with no nesting or baseline refresh.
- Every input Train and the Junction fork the same frozen Terminus commit. Input acceptance is automatic independent validation plus Conductor compatibility review. After all inputs, complete feature validation/review precede commit-bound human release. Incoming unloads have a Junction destination and must never appear in canonical history or Terminus-only clearance/repair paths. Legacy unloads mean Terminus.
- Junction input merges are another explicit pre-Terminus merge boundary. Preserve merge history and accepted Car commits. Target reservations stay active until the Junction head, accepted ledger, receipt and events are durably acknowledged; reconcile uncertain writes before retry or abandonment.
- Release creates exactly one outgoing Train from the approved head, retaining the frozen baseline. Copy Cars in integration order, deduplicate original identities, preserve accepted history/evidence/reviews/timestamps and record immediate source/Junction provenance. Integration reviews and Technician changes remain referenced records rather than Station Cars. Final Terminus integration handles newer canonical work.
- Crossings within one Junction are allowed; transfers across feature boundaries are refused. Released outgoing Lines participate in ordinary main-Network Crossing rules. Include feature-release edges when checking dependency cycles.
- Junction Technician repair uses typed conflict/check/review failure references. Conflict scope is recorded files; check/review scope is an explicit bounded file list. Verify actual edits and ancestry independently, validate/review, require exact-candidate human approval, and rerun feature acceptance. Repair approval does not authorize release.
- Siding a required unfinished member blocks fixed membership. Abandonment resolves promotions first and sides unfinished members through their workflows at safe gates. Preserve already accepted work; never partially release or roll it back.
