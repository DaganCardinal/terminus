# Application Structure and Ownership

## Junction ownership

Junctions add a convergence boundary before canonical Terminus integration. The domain owns frozen feature membership, endpoint rules, acceptance and release transitions. One Junction Workflow owns its lifecycle and serializes promotions into its repository; each incoming and outgoing Train Workflow remains the only writer of its Train state. Dispatcher commands persist commit-bound release approval and explicit retry, repair and abandonment requests.

The shared Integration Workflow handles explicit Terminus, Crossing and Junction purposes. Destination-aware unloading into a Junction does not enter canonical history. D1 acknowledges a reviewed promotion and its accepted-input ledger atomically before releasing the target reservation. Artifacts owns accepted history, and only orchestration receives credentials to promote into a Junction.

The UI projects convergence topology, feature checks, blockers, approval waits and release controls from backend state. See [Junctions](junctions.md) for implementation, recovery and verification instructions.

## Purpose

The application should be structured so that the orchestration logic, domain model, persistence, AI agents, and UI are clearly separated.

The central architectural principle is:

> **The railway network is the domain model. The map is a visualization of that model, not the system itself.**

The application should continue to function correctly even if the map UI is removed entirely.

The UI should never be responsible for deciding what happens next in the workflow. It should display current state, accept user input, and send commands to the backend.

---

# High-Level Architecture

The application consists of five main layers:

1. **Domain**
2. **Orchestration**
3. **Execution**
4. **Persistence / Artifacts**
5. **UI**

Conceptually:

```text
User
  │
  ▼
UI / Map
  │
  │ commands
  ▼
Dispatcher
  │
  ▼
Domain State
  │
  ├── Station work
  ├── Conductor review
  ├── Technician work
  └── Workflow execution
  │
  ▼
Artifacts / Repository State
  │
  ▼
Events + Updated Domain State
  │
  ▼
Dispatcher
  │
  ▼
UI / Map
```

The backend owns the truth.

The frontend renders that truth.

---

# Recommended Project Structure

Use a TypeScript monorepo with clear package boundaries.

A suggested structure is:

```text
/
├── apps/
│   ├── web/
│   │   ├── components/
│   │   ├── map/
│   │   ├── views/
│   │   └── state/
│   │
│   └── worker/
│       ├── api/
│       ├── agents/
│       ├── workflows/
│       └── integrations/
│
├── packages/
│   ├── domain/
│   ├── protocol/
│   ├── agent-runtime/
│   ├── artifacts/
│   └── ui/
│
└── tests/
```

Exact filenames and framework conventions may change, but these boundaries should remain intact.

Avoid placing significant application logic in miscellaneous locations such as:

```text
/scripts/
/utils/
/helpers/
```

Those directories should not become dumping grounds for orchestration or domain logic.

If a piece of code controls how the application behaves, it should live in an explicitly named architectural layer.

---

# 1. Domain Layer

The `domain` package is the core of the application.

It defines what the railway system means.

It owns concepts such as:

- Projects
- Networks
- Trains
- Stations
- Work manifests
- Integration snapshots
- Conflicts
- Reviews
- Agent assignments
- Statuses
- State transitions
- Domain events

The domain layer should define the lifecycle of the system independently of Cloudflare, AI models, React, or any specific persistence mechanism.

Examples of domain transitions include:

```text
Station waiting
→ signaled
→ active
→ ready_for_pickup
→ in_review
→ complete        (car.attached)
```

Likewise:

```text
Train ready
→ in_transit      (train.departed)
→ approaching
→ docked
→ reviewing
→ ready           (departs again, or returning → Terminus → unloaded)
```

The full state lists, including `held`, `blocked`, `revising`, `cancelled`, and the `siding`, are defined in `outline-updated.md` under "Train States" and "Station States".

The domain layer determines which transitions are valid.

It should be possible to test the entire logical railway lifecycle without:

- rendering the UI
- calling an LLM
- launching a Cloudflare Workflow
- modifying a real repository

This is an important architectural constraint.

---

# 2. Dispatcher

The Dispatcher is the primary orchestration authority.

Each project/network should have a Dispatcher responsible for coordinating the complete system.

The Dispatcher owns the overall network state: topology, cross-Line dependencies, and network-level holds. Each Train owns its own lifecycle state, which it moves through under its Conductor and Engineer. The Dispatcher is involved with a Train only when that Train raises an issue.

Dispatcher responsibilities include:

- maintaining the overall network state
- laying out Lines and Stations, and creating Trains
- detecting or receiving conflicts between Lines
- responding to issues raised by Trains
- invoking Technicians when necessary
- making state changes available to connected clients
- recording network activity/events

Each Train, through its Conductor and Engineer, handles:

- signaling its next Station to begin work
- responding to completed Station work
- running Conductor reviews
- attaching Cars and updating its integration state
- progressing through its Line

The backend (the Dispatcher and each Train's lifecycle) is authoritative.

The browser should never orchestrate the workflow.

For example, the browser must not implement logic equivalent to:

```text
Station finished
→ call Conductor
→ update train
→ start next station
```

Instead:

```text
Station finished
→ the Train's lifecycle (backend) receives the event
→ domain state is updated
→ the Train invokes the next action (Conductor review)
→ updated state is made available to clients
```

This ensures the project continues running even when no browser is connected.

---

# 3. Agent Roles

The conceptual agents in the system are:

## Dispatcher

Responsible for overall coordination and network state.

This is the central orchestration role.

---

## Station Agent

Responsible for completing the work described by a Station's structured work manifest.

Typical responsibilities include:

- inspecting the relevant repository
- understanding the station goal
- planning implementation
- modifying code
- running tests/checks
- iterating on failures
- preparing completed work for review

The Station Agent should focus only on its assigned work.

It should not determine broader project orchestration.

---

## Conductor

Responsible for reviewing work before it is incorporated into the Train's evolving integration state.

Typical responsibilities include:

- inspecting completed Station work
- comparing it with the Train's current integration snapshot
- reviewing quality and compatibility
- identifying conflicts or regressions
- accepting or rejecting the Station's work
- incorporating approved work into the Train

The Conductor represents the quality/integration boundary.

A Station completing work does **not** automatically mean that work becomes part of the Train.

---

## Engineer

Responsible for the operational movement of each Train. There is one Engineer per Train.

The Engineer is primarily deterministic. It applies hard domain rules (for example, failed required tests, an unresolved conflict, an incomplete dependency, or a user hold) to decide whether the Train may depart, wait, retry, or stop. It may consult a lightweight decision model only for genuinely ambiguous operational choices, and it never overrides a hard rule.

The Engineer controls the signals shown on the map.

---

## Technician

Responsible for resolving conflicts or integration problems.

The Technician should normally be invoked only when needed.

Typical responsibilities include:

- investigating merge/integration conflicts
- understanding incompatible changes
- proposing or implementing resolutions
- validating the resolved result
- returning the corrected state to the Dispatcher/Conductor

Some conflicts may instead be surfaced to the user for manual resolution.

---

# Agent Roles vs Runtime Instances

The conceptual roles above should not automatically map one-to-one to permanent infrastructure.

For example:

```text
Dispatcher
→ likely long-lived / stateful

Station Agent
→ may be created for individual Station execution

Conductor
→ may be invoked when review is required

Engineer
→ mostly deterministic domain rules evaluated at each gate, not a long-running agent

Technician
→ may exist only while resolving a conflict
```

The architecture should preserve the conceptual roles while allowing the runtime implementation to remain efficient.

Avoid creating separate large services simply because the visual metaphor contains separate characters.

---

# 4. Workflows

Long-running or multi-step execution should live in durable workflows rather than HTTP request handlers or UI processes.

Examples include:

```text
Station Work

Inspect repository
→ Understand manifest
→ Implement changes
→ Run tests
→ Fix failures
→ Produce final result
```

and:

```text
Conductor Review

Load Station result
→ Compare against Train snapshot
→ Run validation
→ Detect conflicts
→ Accept / reject / escalate
```

Workflows should be responsible for reliable execution.

Agents perform reasoning.

The Dispatcher and each Train's lifecycle perform orchestration.

These responsibilities should remain distinct.

---

# 5. Artifacts / Repository Layer

Artifacts represents the actual versioned code state underneath the railway.

The railway metaphor should correspond to real evolving repositories rather than arbitrary UI state.

Conceptually:

```text
Project baseline
    │
    ├── Train A integration state
    │      │
    │      ├── Station A1 work
    │      ├── Station A2 work
    │      └── Station A3 work
    │
    └── Train B integration state
           │
           ├── Station B1 work
           └── Station B2 work
```

Each Station should work in an isolated context.

Each Train should represent an evolving integration snapshot.

When a Conductor accepts Station work, the Train's actual underlying versioned state should change.

This means the UI visualization reflects something real:

```text
Train
├── Accepted Station A
├── Accepted Station B
└── Current integration snapshot
```

rather than merely displaying fictional railway progress.

---

# 6. Map UI

The primary UI should be a 2D railway/network map.

The map is a projection of domain state.

It should be responsible for:

- drawing stations
- drawing tracks/routes
- drawing trains
- showing train positions
- showing station statuses
- showing signals
- showing conflicts/blockers
- showing current work activity
- opening detail/inspection panels
- accepting user commands

It must **not** own orchestration logic.

The UI should receive semantic state such as:

```text
Train:
- status: in_transit
- Origin: Station A
- Destination: Station B

Station B:
- status: active
```

The frontend may interpret that state visually as:

```text
Train moves toward Station B
Station B becomes active
Signal changes state
Activity indicator appears
```

But the visual animation must not cause the underlying workflow to progress.

The state controls the map.

The map does not control the state.

---

# 7. Client / Server Protocol

The frontend and backend should communicate through a shared typed protocol.

This protocol should define:

- commands
- domain events
- state snapshots
- incremental state updates
- progress events
- user approval requests

Examples of events include:

```text
station.signaled
station.started
station.ready_for_pickup

train.departed
train.approaching
train.arrived

review.started
car.attached
station.returned

conflict.detected
conflict.resolved
```

The full vocabulary and naming conventions are in `outline-updated.md`. When in doubt, prefer the railway-metaphor name.

These should be domain-oriented events rather than UI-specific instructions.

Avoid messages such as:

```text
moveTrainToX
flashSignalRed
showLoadingSpinner
```

Prefer:

```text
train.status = in_transit

station.status = active

conflict.status = unresolved
```

The frontend decides how those states should be presented.

---

# 8. Event Stream and Activity History

Domain events should also power the human-readable activity feed.

For example:

```text
07:41 — Backend train departed Database Station
07:41 — API Station signaled
07:42 — Station Agent began implementation
07:46 — Station work completed
07:46 — Backend train approaching API Station
07:47 — Conductor review started
07:48 — Work accepted
07:48 — Train integration snapshot updated
```

The activity log should derive from actual system events.

Avoid maintaining a completely separate logging representation of the same workflow.

---

# 9. Application State Ownership

Ownership should be explicit.

| Layer         | Responsibility                                                                     |
| ------------- | ---------------------------------------------------------------------------------- |
| Domain        | Defines what trains, stations, manifests, conflicts, reviews, and transitions mean |
| Dispatcher    | Plans the network; owns overall network state; handles issues raised by Trains     |
| Station Agent | Performs Station implementation work                                               |
| Conductor     | In charge of its Train; reviews Station work and attaches Cars                     |
| Engineer      | Gates each Train's movement with deterministic rules; controls signals             |
| Technician    | Resolves integration conflicts                                                     |
| Workflows     | Executes reliable long-running processes                                           |
| Artifacts     | Stores actual repositories, commits, history, and evolving code state              |
| Protocol      | Defines communication between backend and frontend                                 |
| Web UI        | Displays controls, logs, inspectors, approvals, and project information            |
| Map           | Visualizes the railway/network state                                               |

---

# 10. Core Application Loop

The application should fundamentally operate as:

```text
User defines intent
        │
        ▼
Dispatcher creates/updates network
        │
        ▼
Domain state determines available work
        │
        ▼
Train departs; Station is signaled
        │
        ▼
Station Agent performs work
        │
        ▼
Station produces versioned result
        │
        ▼
Train approaches Station
        │
        ▼
Conductor reviews work
        │
        ├── accepted
        │      │
        │      ▼
        │  Train integration snapshot updated
        │      │
        │      ▼
        │  Train departs
        │      │
        │      ▼
        │  Next Station signaled
        │
        └── conflict/problem
               │
               ▼
        Technician or user resolution
               │
               ▼
          Review continues
```

The UI observes this loop and renders it.

The UI does not implement this loop.

---

# 11. Train Movement and Work Timing

The intended railway behavior is:

```text
Train departs current Station
        │
        ▼
Next Station is signaled
        │
        ▼
Station Agent begins work while Train is in transit
        │
        ▼
Station work progresses
        │
        ▼
Station becomes ready for pickup
        │
        ▼
Train arrives
        │
        ▼
Conductor review occurs
        │
        ▼
Accepted work becomes part of Train
        │
        ▼
Train departs toward next Station
```

This makes Train movement represent ongoing work rather than waiting for all work to finish before animation begins.

The map therefore acts as a meaningful progress visualization.

---

# 12. Structured Station Manifests

Every Station should have a structured work manifest.

The manifest is the contract between:

- Dispatcher
- Station Agent
- Conductor
- UI

It should describe the intended work sufficiently clearly that downstream systems do not need to infer basic task structure from arbitrary chat history.

The manifest should eventually contain information such as:

- Station goal
- expected outcome
- scope
- relevant repository/context
- dependencies
- constraints
- validation requirements
- completion criteria

The exact manifest schema can evolve, but the concept should be treated as a first-class domain object rather than storing the task only as free-form prompt text.

---

# 13. Evolving Integration Snapshots

Each Train must have an explicit concept of its current integrated state.

A Train is not simply a visual container for completed Stations.

It represents the version of the project produced by the work it has accepted so far.

Conceptually:

```text
Train starts from baseline
        │
        ▼
Station A accepted
        │
        ▼
Integration Snapshot 1
        │
        ▼
Station B accepted
        │
        ▼
Integration Snapshot 2
        │
        ▼
Station C accepted
        │
        ▼
Integration Snapshot 3
```

Every Conductor review compares proposed Station work against this evolving snapshot.

This should be modeled explicitly throughout the system.

---

# 14. Avoid Hidden Logic

Important business logic should never be buried inside miscellaneous scripts.

Do not allow the architecture to evolve into:

```text
/scripts/
  run-agent.mjs
  do-station.mjs
  merge-stuff.mjs
  workflow-helper.mjs
  dispatcher-loop.mjs
  integration.mjs
  final-final-helper.mjs
```

A file containing meaningful behavior should have an obvious architectural home.

Examples:

```text
Domain rule
→ packages/domain

Dispatcher orchestration
→ apps/worker/agents/dispatcher

Station execution workflow
→ apps/worker/workflows

Artifacts-specific implementation
→ packages/artifacts

Shared frontend/backend event definition
→ packages/protocol

Map rendering
→ apps/web/map
```

The directory structure should make it possible to understand the application's architecture without reading every file.

---

# 15. Dependency Direction

Dependencies should generally flow inward toward the domain.

Conceptually:

```text
UI
 │
 ▼
Protocol

Cloudflare runtime
 │
 ▼
Orchestration
 │
 ▼
Domain

Artifacts adapter
 │
 ▼
Domain interfaces
```

The Domain layer should not import:

- React
- Cloudflare Worker APIs
- Cloudflare Agents
- Cloudflare Workflows
- Artifacts SDK implementation details
- model-provider SDKs

Instead, outer layers adapt those technologies to the domain.

This keeps the core architecture portable and understandable.

---

# 16. Development Strategy

The orchestration engine should be functional before significant effort is placed into visual polish.

A useful early implementation could have an extremely basic UI showing:

```text
Train A
Status: in_transit
Destination: Station 3

Station 3
Status: active
Agent: Station Agent
Progress: Running tests

Station 4
Status: waiting
```

If that interface can:

- execute Station work
- update repositories
- move through lifecycle states
- perform Conductor reviews
- evolve Train integration snapshots
- detect conflicts
- invoke Technician resolution
- maintain the correct event history

then the core application is working.

The 2D railway map should then render this established system state rather than becoming the place where that behavior is implemented.

---

# Architectural Principle

When deciding where new functionality belongs, use this rule:

> **If the functionality changes what the system means or what happens next, it belongs on the backend/domain side.**

> **If the functionality changes how the current state is displayed or interacted with, it belongs in the UI.**

The railway visualization should remain replaceable.

The orchestration system should not be.
