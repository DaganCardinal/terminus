# Application Structure and Ownership

> **The railway network is the domain model. The map is a projection of that model, not the system itself.**

Backend orchestration runs independently of browsers. The UI displays state and submits commands; it never decides whether work may start, be accepted, move or integrate. [Technology architecture](technology-architecture.md) describes the runtime and storage boundaries; [AGENTS.md](../AGENTS.md) supplies the governing rules.

## Source layout

```text
apps/
  web/src/
    components/       UI composition and controls
    map/              SVG railway layout and rendering
    views/            Network, Train, Station, Dispatcher and settings panels
    state/            API clients, snapshot and activity polling
  worker/src/
    api/              HTTP routes, authentication and request boundaries
    agents/           Deterministic Dispatcher commands and role wiring
    workflows/        Durable Train, Station, integration, planning and repair execution
    integrations/     D1, Sandbox, provider transport and Worker Git adapters
  stress-test/        Explicit ten-Train CLI and local rehearsal
  perf-tail/          Temporary benchmark log collection
packages/
  domain/             Pure railway concepts, transitions, invariants and gates
  protocol/           Zod schemas, commands, events, snapshots and shared contracts
  agent-runtime/      Role prompts, capabilities, harness adapters and model interfaces
  artifacts/          Repository operations, Git history and promotion mechanics
  ui/                 Shared React components without orchestration knowledge
```

Exact filenames can change; ownership boundaries cannot. Runtime behavior belongs in a named layer, never a catch-all `scripts`, `utils` or `helpers` directory. Scripts are limited to development or maintenance diagnostics.

## Where code goes

| Responsibility | Owner |
| --- | --- |
| Define legal Train, Station, Car, Crossing or Junction behavior | `packages/domain` |
| Engineer hard gates, retry allowance and lifecycle transitions | `packages/domain` |
| Validate a shape crossing an API, Workflow or model boundary | `packages/protocol` |
| Curated model/harness compatibility and shared execution schemas | `packages/protocol` |
| Define role instructions, capabilities, tools and structured outputs | `packages/agent-runtime` |
| Implement text model and typed decision-model interfaces | `packages/agent-runtime` |
| Create, fork, inspect or promote repositories; verify ancestry and exact commits | `packages/artifacts` |
| Apply user/network commands and wire role implementations | `apps/worker/src/agents` |
| Coordinate durable steps, retries, waits and recovery | `apps/worker/src/workflows` |
| Authenticate HTTP requests and validate command input | `apps/worker/src/api` |
| Adapt D1, Sandboxes, outbound requests and Worker filesystem/HTTP transport | `apps/worker/src/integrations` |
| Render domain state, inspection panels and command controls | `apps/web/src` |
| Build reusable visual components | `packages/ui` |

For example, fast-forward ancestry checks belong in `packages/artifacts`, the Worker's temporary filesystem and scoped fetch adapter belong in `apps/worker/src/integrations`, and the acceptance step that invokes them belongs in the Train Workflow. Rendering an accepted Car belongs in the web app.

## Role ownership

| Role | Responsibility | Boundary |
| --- | --- | --- |
| Dispatcher | Goals, proposals, topology, network holds, conflict forecasts and escalations | Does not implement product code or write Train lifecycle state |
| Station Agent | One manifest in an isolated run workspace | Cannot accept its own work or write a Train/Terminus |
| Conductor | Independent candidate review against manifests, actual changes and evidence | Does not implement fixes; its sealed checkout must remain unchanged |
| Engineer | Deterministic movement gates, bounded ambiguous decisions and selective Dispatch notices | Cannot override hard rules or release a hold through an advisory decision |
| Technician | Bounded exceptional repairs in an isolated repository | Cannot silently rewrite accepted Train or canonical history |

Roles are application responsibilities, not permanent services. The Dispatcher combines deterministic commands with read-only model planning/investigation. The Engineer is evaluated at Workflow gates and calls a typed `DecisionModel` only for eligible questions. Coding/review roles use the shared `prepareHarness` path, with capability profiles owned by `packages/agent-runtime` and infrastructure enforcement in the Worker.

## Lifecycle writers

| Entity or process | Owning execution |
| --- | --- |
| Train lifecycle | One Train Workflow per Train |
| Station execution result | One Station Workflow per run, consumed by the owning Train Workflow |
| Merge candidate and promotion attempt | Shared Integration Workflow with explicit Terminus, Crossing or Junction purpose |
| Junction lifecycle and input scheduling | One Junction Workflow per Junction |
| Planning and explicit launch | One Dispatch Workflow per planning request |
| Technician candidate and review | One Technician Workflow per repair |
| Advisory collision investigation | One Conflict Watch Workflow per eligible accepted Car |

The Dispatcher and user persist commands, permissions and requests. Station results and cross-entity notifications wake the owner. They never directly write a Train's lifecycle state. Durable receipts and periodic gate checks recover missing notifications.

Domain rules define valid transitions; Workflows execute them reliably; D1 persists them with their events. Infrastructure retries cannot silently grant another Station revision or replace a frozen model/harness configuration.

## Work manifests and accepted snapshots

A Work Manifest is a structured domain object stored in D1. It contains the goal, concrete repository change, scope, expected/avoided areas, contracts, invariants, dependencies, acceptance criteria and expected evidence. Protocol schemas validate it before execution. A copy supplied to a harness is context, not another source of truth.

Departure starts Station work from the Train's current accepted snapshot. Finishing an implementation produces a proposed Station commit, not a Car. Trusted validation runs in a fresh Conductor checkout before model access. After independent review, orchestration fast-forwards the candidate onto the Train and atomically records the Car and event before signaling the next Station.

A Car references accepted history, manifest, execution identity, actual diff, evidence and verdict. It has no repository of its own. The Train repository is its cumulative integration snapshot. Rejected candidates and failed evidence remain inspectable; explicit intervention retains lifetime revision history.

## Convergence and human permissions

Terminus alone represents canonical project state. Configured Crossings and Junctions are explicit merge boundaries before canonical integration; ordinary Station acceptance remains a fast-forward.

A Crossing visits a source Station's frozen accepted checkpoint, merges that prefix into the receiving Train and copies missing original Cars with provenance. Source work is never rerun. Only the receiving Train Workflow completes pickup and changes its Train state.

A Junction owns fixed feature membership and a frozen canonical baseline. Its Workflow serializes input integrations and owns feature acceptance. Incoming unloads change feature state, not canonical history. Complete checks and Conductor review precede exact-commit human release, which creates one outgoing Train carrying the feature's Cars and original history. See [Junctions](junctions.md).

Integration reservations belong to the exact target repository. Unknown promotions must be reconciled before retry or abandonment. Junction receipts retain exclusion until the head, accepted-input ledger, provenance and events are acknowledged atomically.

Unloading approval, repair approval and feature release are separate Dispatcher-owned permissions. Each binds to the relevant exact commit and never overrides other hard gates. The Train Workflow owns its approval hold; the UI's review yard is a projection of that reason.

## Persistence and event ownership

| Information | Source of truth |
| --- | --- |
| Canonical, Train, Station, Junction, repair and published code/history | Artifacts |
| Network topology, manifests, lifecycle records, Cars and provenance | Domain + D1 |
| Settings, immutable execution configuration and human permissions | D1 |
| Domain event feed and audit trail | D1, in the same batch as the state change |
| Durable execution checkpoints and waits | Workflows |
| Disposable checkouts and running processes | Sandboxes |
| Selection, zoom, layout and animation | React |

The domain event log powers both user activity and audit history. Safe harness observations and temporary benchmark logs are separate telemetry with no authority over orchestration. R2 dependency caches are disposable; losing them causes an install rather than loss of work.

## Map and interaction

The map renders snapshots, signals, explicit blockers and topology. A Train in transit shows work of unknown duration; animation never means percentage completion and cannot arrive at a Station before the backend reports readiness. Arrival, review, departure and unloading come from backend state/events.

Crossing visits, Junction acceptance, review-yard holds and siding remain visible and inspectable. Line numbers, colours, profiles and coordinates are deterministic presentation projections, not stored domain topology. See [Network map](network-map.md).

The web app communicates only through `packages/protocol` and application commands. Polling new events reloads authoritative snapshots. Closing, reopening or refreshing the app cannot start a Workflow, accept work or change a movement gate.

## Dependency direction and verification

Dependencies point inward toward domain concepts. `packages/domain` imports no React, Worker, Workflow, D1, Sandbox, Artifacts or model APIs and runs no Git commands. Infrastructure adapts domain interfaces. Agent results use protocol-defined shapes and are validated before commands act on them.

Pure domain tests cover transitions and hard gates without UI, models, Workflows, Sandboxes or real repositories. Git mechanics have real temporary-repository tests; Worker tests exercise D1 and Workflows with fake execution. Live provider and container verification is separate from offline evidence. Tests live beside the code they verify; the normal checks are listed in the [README](../README.md#checks).
