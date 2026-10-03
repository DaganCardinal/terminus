# AGENTS.md

Guidance for coding agents working on the Terminus codebase.

Terminus is an orchestration platform that coordinates many coding agents working on one shared codebase. It uses a railway network as its coordination model, and it runs on Cloudflare with **Cloudflare Artifacts** as its Git layer.

> **Project status:** scaffolded. The monorepo, toolchain, and folder structure are in place (see [Commands](#commands)), but no domain logic, API, workflows, or UI exist yet. If a decision isn't covered here or in `docs/`, ask the maintainer instead of assuming.

## Project context

- Terminus is being built as an entry for Cloudflare's "next Git platform" competition. **The submission deadline is October 14, 2026.** The project must use **Cloudflare Workers** and **Cloudflare Artifacts**. The minimum bar is a demo of multiple agents working on changes concurrently.
- The submission must include a 5–10 minute demo video, source code under a permissive open-source license (MIT; see `license.md`), and instructions for running the project. Prioritize work that makes the end-to-end concurrent-agent flow real and demonstrable.
- The Terminus source code is hosted on GitHub. The *projects Terminus manages* live in Artifacts.
- `../terminus-demo-app` (a sibling of this repo) is the local demo project for testing Terminus end to end.

## Design docs

Read these when you need more depth:

| Doc | Covers |
| --- | --- |
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
| **Project** | One managed codebase, backed by one canonical Terminus repository in Artifacts. |
| **Network** | All the Lines, Trains, and Stations for a Project, coordinated by one Dispatcher. |
| **Terminus** | The canonical project state. It is **not** just `main`. Only a Train that passes integration checks is promoted into it. |
| **Line** | An ordered workstream that runs from a distant **depot**, through its Stations, to Terminus. It is not a branch. Lines don't branch or merge before Terminus. |
| **Station** | One clearly defined task, defined by a Work Manifest. It is not an issue. |
| **Work Manifest** | The structured definition of a Station: goal, scope, expected areas, areas to avoid, contracts, invariants, dependencies, acceptance criteria, and expected evidence. It is a first-class domain object stored in D1, never just a prompt. |
| **Train** | The evolving integration snapshot for a Line. It is not a branch. Its repository is forked from Terminus when the Train is created, and it accumulates accepted work in order. Each Train owns its own state. |
| **Car** | One accepted unit of work on a Train. It is not a commit. A Car is a D1 domain record with provenance (manifest, agent config, source and accepted commits, diff, evidence, review) that references the Train repository. It has no repository of its own. |
| **Depot** | The far end of a Line, where its Train is created. |
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
- The two terminal states: `unloaded` means the Train's work was integrated into Terminus and the Train is removed from the map (its Cars stay in history). `siding` means the Train was abandoned and parked on the siding.

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
| Code execution | Cloudflare Sandboxes + OpenCode harness | Isolated environments where agents clone, edit, build, test, and commit | Anything durable. Losing a Sandbox must lose nothing accepted. |
| AI | Workers AI + AI Gateway; Clef for Engineer decisions | Model execution and routing behind a `ModelProvider` abstraction | Role identity |

**Do not add infrastructure without approval.** This includes custom Durable Objects, Queues, R2, KV, Vectorize, or another database. The Durable Object binding that the Sandbox SDK requires is part of using Sandboxes and is fine. The goal is a coherent system built from a few primitives, not a tour of Cloudflare products.

**Never hardcode model IDs.** Code asks for a role or capability, and the model is configuration. Users will be able to configure models per role in the future. Default model choices are listed in `docs/technology-architecture.md`. Where practical, configure the Conductor with a different model family from the Station Agent.

---

## Execution model

These decisions are settled. The details are in `docs/technology-architecture.md`.

- **Workflows:**
  - **One Train Workflow per Train.** It runs the whole lifecycle from the depot to `unloaded` or `siding`, and it is the **only writer** of that Train's state. The Dispatcher, the user, and Station Workflows send events to it and never write the Train's state directly.
  - **One Station Workflow per Station run.**
  - **One Terminus integration Workflow per integration attempt.**
- **Station execution:**
  1. Fork the Station repo from the Train.
  2. Issue a short-lived token that can write only to the Station repo.
  3. Start a Sandbox, clone the repo, and write the manifest into it.
  4. Run `opencode run --format json --auto --model <configured> -- <prompt>`.
  5. Wait for the process to exit.
  6. **Our code** runs validation and collects evidence. Never use the agent's own summary as evidence.
  7. Push, then mark the Station `ready_for_pickup`.
- **Completion is detected when the harness process exits.** Do not use Artifacts push notifications for this. They need a subscription per repository and are delivered to a Queue.
- **Non-harness roles:** the Dispatcher, Conductor, and Engineer models are called directly through `ModelProvider` with structured output.
- **Model credentials never enter a Sandbox.** The Worker's outbound handler swaps the harness's placeholder key for the real AI Gateway token on each request.
- **The UI polls.**
  - It loads a snapshot, then polls `GET /networks/:id/events?after=<seq>`.
  - Each state change and its domain event are written in the **same D1 batch**.
  - No WebSockets or Durable Objects without approval.
- **Onboarding:**
  - A project's Terminus repo is created by importing a public Git URL, or by `create()` followed by an initial push.
  - Code is retrieved with `git clone`.
  - There is no GitHub sync, and importing private repos is out of scope.

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
- `in_transit` means work is in progress. It is **not** a progress percentage or a timer. A Train moves to `approaching` because its Station became `ready_for_pickup`.
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

### Integration, provenance, and security

- **Applying accepted Station work to a Train is always a fast-forward.** The Artifacts binding has no merge, so the push goes over the Git protocol from orchestration code, never from the Station Agent. If the Train has moved since the Station was forked, re-review the work. Never force it.
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
| `npm run dev:web` | Starts the Vite dev server for `apps/web` |
| `npm run dev:worker` | Starts `wrangler dev` for `apps/worker` |
| `npm run build` | Builds every workspace that has a `build` script (currently `apps/web`) |
| `npm run typecheck` | Type-checks every workspace |
| `npm test` | Runs Vitest in every workspace (`apps/worker` runs in the Workers runtime) |
| `npm run lint` | Lints the repo with the root ESLint config |
| `npm run format` / `npm run format:check` | Formats or checks code with Prettier (Markdown is ignored) |

Workspace-specific commands:

- Add a shadcn component: `npx shadcn@latest add <component> -c apps/web`. Components are written to `packages/ui/src/components` and imported as `@terminus/ui/components/<name>`.
- Regenerate Worker binding types after editing `apps/worker/wrangler.jsonc`: `npm run cf-typegen -w @terminus/worker`.
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
